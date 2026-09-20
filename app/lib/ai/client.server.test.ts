import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AiClient, estimateCostMicros, totalUsage } from "./client.server.js";
import type { ListingPromptInput } from "./prompts.js";

const SOURCE = "Cotton blouse. Material: 95% cotton. Weight 240g. Machine washable at 30 degrees.";

const PROMPT_INPUT: ListingPromptInput = {
  supplierTitle: "Women Shirt Loose Casual Blouse Top New 2024 Hot Sale",
  supplierDescription: "High quality cotton material comfortable wear",
  categoryPath: "Women Clothing",
  optionSummary: "Color: Red, Blue; Size: S, M, L",
  languageName: "German",
  countryName: "Germany",
  tone: "friendly",
};

const GOOD_LISTING = {
  title: "Lockere Baumwollbluse für jeden Tag",
  descriptionHtml: "<p>Eine weiche Baumwollbluse, die den ganzen Tag angenehm zu tragen ist und sich leicht kombinieren lässt.</p>",
  bullets: [
    "Atmungsaktive Baumwolle für angenehmes Tragegefühl",
    "Lockerer Schnitt für jede Figur",
    "Maschinenwaschbar bei 30 Grad",
    "Lange Ärmel für kühlere Abende",
    "Passt zu Jeans und eleganter Kleidung",
  ],
  seoTitle: "Lockere Baumwollbluse",
  seoDescription: "Weiche, atmungsaktive Baumwollbluse mit lockerem Schnitt für jeden Tag und jede Gelegenheit.",
  tags: ["bluse", "baumwolle", "damenoberteil"],
  claims: [{ claim: "95% Baumwolle", evidence: "Material: 95% cotton" }],
};

/** Minimal stand-in for the SDK, so tests never touch the network. */
function fakeClient(responses: unknown[]): Anthropic {
  const parse = vi.fn();
  for (const response of responses) parse.mockResolvedValueOnce(response);
  return { messages: { parse } } as unknown as Anthropic;
}

function parseCalls(client: Anthropic) {
  return (client.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

function response(parsed: unknown, overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-opus-5",
    stop_reason: "end_turn",
    parsed_output: parsed,
    usage: { input_tokens: 1500, output_tokens: 900, cache_read_input_tokens: 0 },
    ...overrides,
  };
}

describe("generateListing", () => {
  it("returns validated output and records usage", async () => {
    const client = new AiClient(fakeClient([response(GOOD_LISTING)]));
    const result = await client.generateListing(PROMPT_INPUT, SOURCE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.title).toBe("Lockere Baumwollbluse für jeden Tag");
      expect(result.usage[0]?.inputTokens).toBe(1500);
      expect(result.promptVersion).toBe("listing-v1");
    }
  });

  it("marks the system prompt as cacheable", async () => {
    const fake = fakeClient([response(GOOD_LISTING)]);
    await new AiClient(fake).generateListing(PROMPT_INPUT, SOURCE);

    const [request] = parseCalls(fake)[0] as [Record<string, any>];
    expect(request.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps the system prompt byte-identical across different inputs", async () => {
    const fake = fakeClient([response(GOOD_LISTING), response(GOOD_LISTING)]);
    const client = new AiClient(fake);

    await client.generateListing(PROMPT_INPUT, SOURCE);
    await client.generateListing(
      { ...PROMPT_INPUT, languageName: "Polish", countryName: "Poland", tone: "premium" },
      SOURCE,
    );

    const first = (parseCalls(fake)[0] as [any])[0];
    const second = (parseCalls(fake)[1] as [any])[0];

    // Caching is a prefix match: a single differing byte in the system prompt
    // invalidates the cache on every call and multiplies the input bill by
    // roughly the number of markets. Variable content belongs in the user turn.
    expect(second.system[0].text).toBe(first.system[0].text);
    expect(second.messages[0].content).not.toBe(first.messages[0].content);
    expect(second.messages[0].content).toContain("Polish");
  });

  it("fences supplier data as untrusted", async () => {
    const fake = fakeClient([response(GOOD_LISTING)]);
    await new AiClient(fake).generateListing(PROMPT_INPUT, SOURCE);

    const [request] = parseCalls(fake)[0] as [Record<string, any>];
    const userMessage: string = request.messages[0].content;
    expect(userMessage).toContain("<supplier_data>");
    expect(userMessage).toContain("untrusted supplier data");
  });

  it("retries once with the violations named, then succeeds", async () => {
    const bad = { ...GOOD_LISTING, title: "Medical grade iPhone case" };
    const fake = fakeClient([response(bad), response(GOOD_LISTING)]);

    const result = await new AiClient(fake).generateListing(PROMPT_INPUT, SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedViolations.length).toBeGreaterThan(0);
      expect(result.usage).toHaveLength(2); // both attempts are billed and recorded
    }

    const [retryRequest] = parseCalls(fake)[1] as [Record<string, any>];
    const retryText: string = retryRequest.messages[2].content;
    expect(retryText).toContain("rejected by automated screening");
    expect(retryText).toContain("medical grade");
  });

  it("gives up after a second screening failure rather than looping", async () => {
    const bad = { ...GOOD_LISTING, title: "Cures back pain instantly" };
    const fake = fakeClient([response(bad), response(bad)]);

    const result = await new AiClient(fake).generateListing(PROMPT_INPUT, SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("GUARDRAIL_REJECTED");
      expect(result.violations.length).toBeGreaterThan(0);
    }
    expect(parseCalls(fake)).toHaveLength(2);
  });

  it("surfaces a refusal instead of reading empty content", async () => {
    const fake = fakeClient([
      response(null, { stop_reason: "refusal", stop_details: { category: "cyber" } }),
    ]);
    const result = await new AiClient(fake).generateListing(PROMPT_INPUT, SOURCE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REFUSED");
  });

  it("reports a schema failure without writing anything", async () => {
    const fake = fakeClient([response(null)]);
    const result = await new AiClient(fake).generateListing(PROMPT_INPUT, SOURCE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SCHEMA_INVALID");
  });

  it("converts an API exception into a result rather than throwing", async () => {
    const fake = { messages: { parse: vi.fn().mockRejectedValue(new Error("529 overloaded")) } } as unknown as Anthropic;
    const result = await new AiClient(fake).generateListing(PROMPT_INPUT, SOURCE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("API_ERROR");
      expect(result.message).toContain("529");
    }
  });

  it("uses medium effort for copy by default and honours an override", async () => {
    const fake = fakeClient([response(GOOD_LISTING), response(GOOD_LISTING)]);
    const client = new AiClient(fake);

    await client.generateListing(PROMPT_INPUT, SOURCE);
    expect((parseCalls(fake)[0] as [any])[0].output_config.effort).toBe("medium");

    await client.generateListing(PROMPT_INPUT, SOURCE, { effort: "high" });
    expect((parseCalls(fake)[1] as [any])[0].output_config.effort).toBe("high");
  });
});

describe("generateCompliance", () => {
  const COMPLIANCE_INPUT = {
    supplierTitle: "Cotton blouse",
    supplierDescription: SOURCE,
    categoryPath: "Women Clothing",
    languageName: "German",
    countryName: "Germany",
  };

  it("keeps evidence-backed fields", async () => {
    const fake = fakeClient([
      response({
        manufacturerName: null,
        manufacturerAddress: null,
        manufacturerEmail: null,
        warnings: null,
        safetyInstructions: null,
        careInstructions: "Maschinenwäsche bei 30 Grad",
        ageRestriction: null,
        productIdentifiers: [],
        evidence: { careInstructions: "Machine washable at 30 degrees" },
        missingFields: ["manufacturerName", "warnings"],
      }),
    ]);

    const result = await new AiClient(fake).generateCompliance(COMPLIANCE_INPUT, SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.careInstructions).toBe("Maschinenwäsche bei 30 Grad");
      expect(result.output.missingFields).toContain("warnings");
    }
  });

  it("drops a fabricated manufacturer address", async () => {
    const fake = fakeClient([
      response({
        manufacturerName: "Plausible GmbH",
        manufacturerAddress: "1 Invented Strasse, Berlin",
        manufacturerEmail: null,
        warnings: null,
        safetyInstructions: null,
        careInstructions: null,
        ageRestriction: null,
        productIdentifiers: [],
        evidence: { manufacturerName: "Plausible GmbH", manufacturerAddress: "1 Invented Strasse" },
        missingFields: [],
      }),
    ]);

    const result = await new AiClient(fake).generateCompliance(COMPLIANCE_INPUT, SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.manufacturerName).toBeNull();
      expect(result.output.manufacturerAddress).toBeNull();
      expect(result.droppedFields).toEqual(["manufacturerName", "manufacturerAddress"]);
    }
  });

  it("does NOT retry — pressure to produce something is the failure mode here", async () => {
    const fake = fakeClient([
      response({
        manufacturerName: "Invented Ltd",
        manufacturerAddress: null, manufacturerEmail: null, warnings: null,
        safetyInstructions: null, careInstructions: null, ageRestriction: null,
        productIdentifiers: [], evidence: {}, missingFields: [],
      }),
    ]);

    await new AiClient(fake).generateCompliance(COMPLIANCE_INPUT, SOURCE);
    expect(parseCalls(fake)).toHaveLength(1);
  });

  it("uses high effort for a legal declaration", async () => {
    const fake = fakeClient([
      response({
        manufacturerName: null, manufacturerAddress: null, manufacturerEmail: null,
        warnings: null, safetyInstructions: null, careInstructions: null,
        ageRestriction: null, productIdentifiers: [], evidence: {}, missingFields: [],
      }),
    ]);
    await new AiClient(fake).generateCompliance(COMPLIANCE_INPUT, SOURCE);
    expect((parseCalls(fake)[0] as [any])[0].output_config.effort).toBe("high");
  });
});

describe("cost accounting", () => {
  it("prices an Opus 5 generation", () => {
    // 1500 in @ $5/M + 900 out @ $25/M = $0.0075 + $0.0225 = $0.03
    expect(estimateCostMicros("claude-opus-5", {
      inputTokens: 1500, outputTokens: 900, cacheReadTokens: 0,
    })).toBe(30_000);
  });

  it("prices cache reads at a tenth of input", () => {
    expect(estimateCostMicros("claude-opus-5", {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000,
    })).toBe(500_000);
  });

  it("prices Sonnet and Haiku", () => {
    expect(estimateCostMicros("claude-sonnet-5", {
      inputTokens: 1500, outputTokens: 900, cacheReadTokens: 0,
    })).toBe(12_000);
    expect(estimateCostMicros("claude-haiku-4-5", {
      inputTokens: 1500, outputTokens: 900, cacheReadTokens: 0,
    })).toBe(6_000);
  });

  it("returns zero for an unknown model rather than guessing", () => {
    expect(estimateCostMicros("some-future-model", {
      inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0,
    })).toBe(0);
  });

  it("sums attempts into a single ledger row", () => {
    const total = totalUsage([
      { model: "claude-opus-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, costMicros: 1750, latencyMs: 900 },
      { model: "claude-opus-5", inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, costMicros: 3005, latencyMs: 1100 },
    ]);
    expect(total.inputTokens).toBe(300);
    expect(total.costMicros).toBe(4755);
    expect(total.latencyMs).toBe(2000);
  });
});
