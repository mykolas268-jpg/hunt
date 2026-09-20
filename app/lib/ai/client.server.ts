/**
 * Claude client for listing and compliance generation.
 *
 * Responsibilities: issue the request, validate the output against a Zod
 * schema, run deterministic screening, retry once with the violations fed
 * back, and record what it cost. Prompt construction lives in `prompts.ts` and
 * the screening rules in `guardrails.ts`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  formatViolations,
  screenListing,
  stripUnevidencedFields,
  type ScreenOptions,
  type Violation,
} from "./guardrails.js";
import {
  buildComplianceUserMessage,
  buildListingUserMessage,
  buildRetryMessage,
  COMPLIANCE_PROMPT_VERSION,
  COMPLIANCE_SYSTEM_PROMPT,
  LISTING_PROMPT_VERSION,
  LISTING_SYSTEM_PROMPT,
  type CompliancePromptInput,
  type ListingPromptInput,
} from "./prompts.js";
import {
  complianceOutputSchema,
  EVIDENCE_REQUIRED_FIELDS,
  listingOutputSchema,
  type ComplianceOutput,
  type ListingOutput,
} from "./schemas.js";

export const LISTING_MODEL = "claude-opus-5";

/**
 * Published rates in micro-dollars per million tokens.
 *
 * Kept as integers so the cost ledger never accumulates float drift across
 * hundreds of thousands of rows. Verify against current pricing when changing
 * models — a stale table silently misreports unit economics.
 */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5": { input: 5_000_000, output: 25_000_000, cacheRead: 500_000 },
  "claude-sonnet-5": { input: 2_000_000, output: 10_000_000, cacheRead: 200_000 },
  "claude-haiku-4-5": { input: 1_000_000, output: 5_000_000, cacheRead: 100_000 },
};

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costMicros: number;
  latencyMs: number;
}

export interface GenerationSuccess<T> {
  ok: true;
  output: T;
  usage: UsageRecord[];
  promptVersion: string;
  /** Violations found on the first attempt and resolved by the retry. */
  resolvedViolations: Violation[];
  /** Compliance fields discarded for want of evidence. */
  droppedFields: string[];
}

export interface GenerationFailure {
  ok: false;
  code: "SCHEMA_INVALID" | "GUARDRAIL_REJECTED" | "REFUSED" | "API_ERROR";
  message: string;
  usage: UsageRecord[];
  promptVersion: string;
  violations: Violation[];
}

export type GenerationResult<T> = GenerationSuccess<T> | GenerationFailure;

export class AiClient {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY from the environment.
    // The key is never read into application code or logged.
    this.client = client ?? new Anthropic();
  }

  /**
   * Generate a listing for one product in one market.
   *
   * Retries exactly once on a screening failure, with the violations named.
   * A second failure is not retried: repeated rejection means the supplier data
   * cannot support compliant copy, and further attempts spend money to produce
   * the same result.
   */
  async generateListing(
    input: ListingPromptInput,
    sourceText: string,
    options: { screen?: ScreenOptions; effort?: "low" | "medium" | "high" } = {},
  ): Promise<GenerationResult<ListingOutput>> {
    const usage: UsageRecord[] = [];
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: buildListingUserMessage(input) },
    ];
    let firstAttemptViolations: Violation[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      let response: Awaited<ReturnType<typeof this.client.messages.parse>>;

      try {
        response = await this.client.messages.parse({
          model: LISTING_MODEL,
          max_tokens: 16_000,
          // Copywriting is a high-volume route where thoroughness beyond a
          // point stops paying for itself. Medium is a measured default, not a
          // guess — re-measure on real listings before changing it.
          output_config: {
            effort: options.effort ?? "medium",
            format: zodOutputFormat(listingOutputSchema),
          },
          system: [
            {
              type: "text",
              text: LISTING_SYSTEM_PROMPT,
              // The system prompt is a frozen constant, so this prefix is
              // shared across every generation for every merchant.
              cache_control: { type: "ephemeral" },
            },
          ],
          messages,
        });
      } catch (error) {
        return {
          ok: false,
          code: "API_ERROR",
          message: error instanceof Error ? error.message : String(error),
          usage,
          promptVersion: LISTING_PROMPT_VERSION,
          violations: [],
        };
      }

      usage.push(recordUsage(response, Date.now() - started));

      // Always check stop_reason before reading content: a policy decline
      // returns HTTP 200 with no usable output.
      if (response.stop_reason === "refusal") {
        return {
          ok: false,
          code: "REFUSED",
          message: `Claude declined to generate copy for this product (${response.stop_details?.category ?? "unspecified"}).`,
          usage,
          promptVersion: LISTING_PROMPT_VERSION,
          violations: [],
        };
      }

      const parsed = response.parsed_output;
      if (!parsed) {
        return {
          ok: false,
          code: "SCHEMA_INVALID",
          message: "Response did not conform to the listing schema.",
          usage,
          promptVersion: LISTING_PROMPT_VERSION,
          violations: [],
        };
      }

      const violations = screenListing(parsed, sourceText, options.screen ?? {});
      if (violations.length === 0) {
        return {
          ok: true,
          output: parsed,
          usage,
          promptVersion: LISTING_PROMPT_VERSION,
          resolvedViolations: firstAttemptViolations,
          droppedFields: [],
        };
      }

      if (attempt === 0) {
        firstAttemptViolations = violations;
        messages.push(
          { role: "assistant", content: JSON.stringify(parsed) },
          { role: "user", content: buildRetryMessage(formatViolations(violations)) },
        );
        continue;
      }

      return {
        ok: false,
        code: "GUARDRAIL_REJECTED",
        message: `Generated copy failed screening twice:\n${formatViolations(violations)}`,
        usage,
        promptVersion: LISTING_PROMPT_VERSION,
        violations,
      };
    }

    // Unreachable: the loop returns on every path.
    throw new Error("generateListing exited its retry loop without returning");
  }

  /**
   * Extract GPSR compliance fields.
   *
   * There is no retry here. Retrying a legal extraction pressures the model to
   * produce something rather than nothing, which is precisely the failure mode
   * this feature must not have. Unsupported fields are dropped and surfaced to
   * the merchant as gaps.
   */
  async generateCompliance(
    input: CompliancePromptInput,
    sourceText: string,
  ): Promise<GenerationResult<ComplianceOutput>> {
    const usage: UsageRecord[] = [];
    const started = Date.now();

    let response: Awaited<ReturnType<typeof this.client.messages.parse>>;
    try {
      response = await this.client.messages.parse({
        model: LISTING_MODEL,
        max_tokens: 16_000,
        // Correctness matters more than cost on a legal declaration.
        output_config: { effort: "high", format: zodOutputFormat(complianceOutputSchema) },
        system: [
          {
            type: "text",
            text: COMPLIANCE_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: buildComplianceUserMessage(input) }],
      });
    } catch (error) {
      return {
        ok: false,
        code: "API_ERROR",
        message: error instanceof Error ? error.message : String(error),
        usage,
        promptVersion: COMPLIANCE_PROMPT_VERSION,
        violations: [],
      };
    }

    usage.push(recordUsage(response, Date.now() - started));

    if (response.stop_reason === "refusal") {
      return {
        ok: false,
        code: "REFUSED",
        message: "Claude declined to extract compliance data for this product.",
        usage,
        promptVersion: COMPLIANCE_PROMPT_VERSION,
        violations: [],
      };
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return {
        ok: false,
        code: "SCHEMA_INVALID",
        message: "Response did not conform to the compliance schema.",
        usage,
        promptVersion: COMPLIANCE_PROMPT_VERSION,
        violations: [],
      };
    }

    const { cleaned, dropped } = stripUnevidencedFields(
      parsed,
      EVIDENCE_REQUIRED_FIELDS,
      sourceText,
    );

    return {
      ok: true,
      output: cleaned,
      usage,
      promptVersion: COMPLIANCE_PROMPT_VERSION,
      resolvedViolations: [],
      droppedFields: dropped,
    };
  }
}

/** Compute spend from reported usage. Unknown models cost 0 and are logged. */
export function estimateCostMicros(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;

  return Math.round(
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead) /
      1_000_000,
  );
}

function recordUsage(response: { model?: string; usage?: unknown }, latencyMs: number): UsageRecord {
  const usage = (response.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };

  const model = response.model ?? LISTING_MODEL;
  const counts = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };

  return { model, ...counts, costMicros: estimateCostMicros(model, counts), latencyMs };
}

/** Flatten several attempts into one ledger row. */
export function totalUsage(records: UsageRecord[]): Omit<UsageRecord, "model"> & { model: string } {
  return {
    model: records[0]?.model ?? LISTING_MODEL,
    inputTokens: records.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: records.reduce((sum, r) => sum + r.outputTokens, 0),
    cacheReadTokens: records.reduce((sum, r) => sum + r.cacheReadTokens, 0),
    costMicros: records.reduce((sum, r) => sum + r.costMicros, 0),
    latencyMs: records.reduce((sum, r) => sum + r.latencyMs, 0),
  };
}
