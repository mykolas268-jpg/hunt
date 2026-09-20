/**
 * Build-plan Task 0 — CJ API spike. THROWAWAY CODE.
 *
 * This exists to answer three questions before anything is built on top of
 * their answers. Run it, read the output, correct the schemas, then delete it.
 *
 *   1. Are CJ API keys issued PER MERCHANT ACCOUNT?
 *      The entire BYO-key model depends on this. If keys are app-scoped, the
 *      rate limit caps the whole business rather than scaling per customer,
 *      and the monitoring feature needs redesigning.
 *
 *   2. What is the actual rate limit and token lifetime?
 *
 *   3. What does a real payload look like — specifically a product with many
 *      variants across several option dimensions? The simple case teaches
 *      nothing; the option matrix is where import actually gets hard.
 *
 * Usage:
 *   CJ_EMAIL=you@example.com CJ_API_KEY=xxx CJ_PID=<product id> npm run spike:cj
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { CjClient } from "../app/adapters/cj/client.js";
import { normalizeProduct } from "../app/adapters/cj/normalize.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See the usage note at the top of this file.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const email = requireEnv("CJ_EMAIL");
  const apiKey = requireEnv("CJ_API_KEY");
  const pid = requireEnv("CJ_PID");

  mkdirSync(FIXTURES, { recursive: true });
  const client = new CjClient({ maxRetries: 0 });

  console.log("\n=== Q2a: token lifetime ===");
  const started = Date.now();
  const credentials = await client.authenticate(email, apiKey);
  console.log(`  authenticated in ${Date.now() - started}ms`);
  console.log(`  access token expires:  ${credentials.accessTokenExpiresAt.toISOString()}`);
  console.log(`  refresh token expires: ${credentials.refreshTokenExpiresAt?.toISOString() ?? "(none)"}`);

  const days = (credentials.accessTokenExpiresAt.getTime() - Date.now()) / 86_400_000;
  console.log(`  -> access token lifetime: ~${days.toFixed(1)} days`);

  console.log("\n=== Q3: real payload shape ===");
  const raw = await client.getProduct(pid, credentials.accessToken);
  const rawPath = new URL(`cj-product-${pid}.local.json`, FIXTURES);
  writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  console.log(`  raw payload saved to ${rawPath.pathname}`);

  const variantCount = raw.variants?.length ?? 0;
  console.log(`  variants: ${variantCount}`);
  if (variantCount < 20) {
    console.warn("  ⚠ Fewer than 20 variants. Re-run with a product that has a");
    console.warn("    large multi-dimension matrix — that is the case that breaks importers.");
  }

  try {
    const normalized = normalizeProduct(raw);
    console.log(`  normalized options: ${JSON.stringify(normalized.options, null, 2)}`);
    const generic = normalized.options.filter((o) => o.name.startsWith("Option "));
    if (generic.length > 0) {
      console.warn(`  ⚠ ${generic.length} option dimension(s) fell back to positional labels.`);
      console.warn("    Check whether the real payload carries usable dimension names.");
    }
  } catch (error) {
    console.error("  ✗ Normalization FAILED against the real payload:", error);
    console.error("    Correct app/adapters/cj/schemas.ts and normalize.ts before proceeding.");
  }

  console.log("\n=== Q2b: rate limit, measured ===");
  const timings: number[] = [];
  let firstFailure: string | null = null;

  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    try {
      await client.getProduct(pid, credentials.accessToken);
      timings.push(Date.now() - t0);
    } catch (error) {
      firstFailure = `call ${i + 1}: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }

  console.log(`  ${timings.length}/10 rapid calls succeeded`);
  console.log(`  timings (ms): ${timings.join(", ")}`);
  if (firstFailure) console.log(`  first failure -> ${firstFailure}`);
  console.log(
    timings.length === 10
      ? "  -> no limit hit at 10 rapid calls; the documented 1 QPS may be soft."
      : "  -> a limit was hit. Set the token bucket to match what you just measured.",
  );

  console.log("\n=== Q1: ANSWER THIS YOURSELF ===");
  console.log("  Open the CJ developer portal with a SECOND merchant account.");
  console.log("  Does that account get its own, different API key?");
  console.log("    YES -> the BYO-key model holds. Record it in docs/ARCHITECTURE.md section 8.");
  console.log("    NO  -> STOP. Rate limits cap the whole business. Redesign tasks 5, 6 and 17.");
  console.log("");
}

main().catch((error) => {
  console.error("\nSpike failed:", error);
  process.exit(1);
});
