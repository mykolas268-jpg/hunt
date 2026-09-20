# Build Plan — MVP

Ordered by **risk**, not by architectural layer. The unknowns that could
invalidate the design are tested first, with throwaway code.

**Effort figures are estimates**, calibrated for a competent engineer who is not
a full-time full-stack developer. Treat them as ranges, not commitments.

| Milestone | Tasks | Est. hours | What exists at the end |
|---|---|---|---|
| M0 — De-risk | 0 | 3–5 | Proof the supplier API supports the business model |
| M1 — Foundations | 1–5 | 20–28 | Deployed skeleton, schema, queue, rate limiter |
| M2 — Import works | 6–8 | 16–22 | Paste a CJ product ID, see it in your app |
| M3 — Content | 9–14 | 26–36 | Localized listings + GPSR drafts, reviewable |
| M4 — Push | 15–16 | 12–18 | Draft product live in Shopify admin |
| M5 — Retention | 17 | 8–12 | Change detection + one-click re-sync |
| M6 — Launch | 18–20 | 14–20 | Submittable to the App Store |
| | | **~100–140h** | |

At 8 productive hours a week, that is **3–4 months**. At 4 hours a week it is
**6–8 months**. Plan against the honest number, not the optimistic one.

---

## M0 — De-risk

### Task 0 — CJ API spike (throwaway code)

**Goal:** Answer three questions before any architecture depends on them.

1. Are CJ API keys issued **per merchant account**? (Blocks the BYO-key model.)
2. What is the **actual** rate limit and token lifetime?
3. What does a real product payload look like — especially the variant/option
   structure and image-to-variant mapping?

**Files:** `spikes/cj-probe.ts` — a standalone script. **Not** application code.
Delete or archive it afterwards.

**Acceptance criteria:**
- [ ] Authenticated against CJ with a real account, token obtained
- [ ] One real product payload saved to `spikes/fixtures/cj-product-*.json`
- [ ] One product with **≥ 20 variants across ≥ 2 option dimensions** captured —
      the simple case teaches you nothing
- [ ] Rate limit measured empirically (fire 10 rapid calls, record what happens)
- [ ] Written answer to question 1 in `docs/ARCHITECTURE.md` § 8

**Test:** `npx tsx spikes/cj-probe.ts` prints payloads and timings.

> 🚩 **Gate.** If keys are app-scoped rather than per-merchant, stop and redesign
> tasks 5, 6 and 17 before continuing. Do not build past this on an assumption.

---

## M1 — Foundations

### Task 1 — Scaffold, deploy, CI

**Goal:** A Shopify app installed on a dev store **and deployed to Railway** on
day one. Apps that only work on localhost hide tunnel, iframe and CSP problems
until it is expensive to find them.

**Files:** whole repo — `shopify app init` (React Router template),
`shopify.app.toml`, `Dockerfile` or `railway.json`, `vitest.config.ts`,
`.github/workflows/ci.yml`, `.env.example`

**Acceptance criteria:**
- [ ] App installs on a development store and renders a Polaris page
- [ ] `shopify.app.toml` declares exactly: `write_products,read_locations,write_inventory`
- [ ] Deployed to Railway; the **deployed** URL loads embedded in Shopify admin
- [ ] `npm test` runs vitest; CI runs typecheck + lint + test on push
- [ ] No secret committed; `.env.example` documents every variable

**Test:** `shopify app dev` locally; then install the deployed build and confirm
it renders inside admin, not just in a browser tab.

### Task 2 — Prisma schema and migrations

**Goal:** Every table from the architecture doc, with real constraints.

**Files:** `prisma/schema.prisma`, `prisma/migrations/`, `app/db.server.ts`

**Acceptance criteria:**
- [ ] All tables created; Shopify's `Session` model left untouched
- [ ] Money columns are `Int` (minor units) + a currency column. **No `Float`,
      no `Decimal`, anywhere.**
- [ ] Unique constraints present on: `Shop.shop_domain`,
      `(supplier_account_id, supplier_product_id)`,
      `(supplier_product_id, supplier_variant_id)`,
      `(product_id, market_id)` on both `Listing` and `ComplianceRecord`,
      `WebhookEvent.shopify_event_id`
- [ ] `onDelete: Cascade` from `Shop` downward, so `shop/redact` is one delete
- [ ] Migration applies cleanly to an empty database

**Test:** `npx prisma migrate reset && npx prisma migrate deploy`. Then write a
seed script and confirm the cascade delete removes every child row.

### Task 3 — Credential encryption

**Goal:** Supplier API keys encrypted at rest. The database alone must never be
enough to drain someone's CJ balance.

**Files:** `app/lib/crypto.server.ts`, `app/lib/crypto.server.test.ts`

**Acceptance criteria:**
- [ ] AES-256-GCM, key from `ENCRYPTION_KEY` (32-byte base64)
- [ ] Random IV per encryption; auth tag stored and verified
- [ ] Decrypting tampered ciphertext **throws**, never returns garbage
- [ ] Module throws at boot if `ENCRYPTION_KEY` is missing or wrong length
- [ ] Round-trip and tamper-detection tests pass

**Test:** `npm test crypto`. Confirm two encryptions of the same plaintext
produce different ciphertexts.

### Task 4 — Queue and worker service

**Goal:** A second deployable process that consumes jobs from Postgres.

**Files:** `app/lib/queue/client.server.ts`, `app/lib/queue/jobs.ts`,
`worker/index.ts`, `worker/handlers/`, Railway worker service config

**Acceptance criteria:**
- [ ] pg-boss starts and creates its schema in the same database
- [ ] A typed `enqueue(jobName, payload)` helper; payloads validated by Zod
- [ ] Worker deployed as a **separate Railway service** from the same repo
- [ ] A no-op `ping` job enqueued from the web app is executed by the worker
- [ ] Graceful shutdown: SIGTERM finishes in-flight jobs before exiting
- [ ] Failed jobs retry with backoff, then dead-letter

**Test:** Enqueue `ping` from a loader, watch worker logs. Kill the worker
mid-job and confirm the job is retried, not lost.

### Task 5 — Per-tenant token bucket

**Goal:** Never exceed the supplier's rate limit, even with concurrent workers.

**Files:** `app/lib/ratelimit/token-bucket.server.ts` + tests

**Acceptance criteria:**
- [ ] Bucket state in Postgres, keyed on `supplier_account_id`
- [ ] Token claimed with `SELECT ... FOR UPDATE SKIP LOCKED` — two workers can
      never spend the same token
- [ ] `acquire()` waits or throws `RateLimitedError` per caller preference
- [ ] Concurrency test: **10 parallel callers, 1 token/sec, over 5 seconds
      → at most 5 acquisitions**

**Test:** `npm test token-bucket`. The concurrency test is the one that matters;
a single-threaded test proves nothing here.

---

## M2 — Import works end to end

### Task 6 — CJ auth and connection UI

**Files:** `app/adapters/types.ts`, `app/adapters/cj/client.ts`,
`app/routes/app.settings.suppliers.tsx`

**Acceptance criteria:**
- [ ] Merchant enters CJ email + API key in a Polaris form
- [ ] Credentials validated by a live call **before** saving
- [ ] Stored encrypted; the key is never returned to the browser after save
- [ ] Token refresh scheduled ahead of expiry, not triggered by failure
- [ ] Invalid credentials set `status = INVALID` and surface a clear message

**Test:** Connect with a real key. Then corrupt the stored token in the DB and
confirm the app recovers via refresh rather than hard-failing.

### Task 7 — Product fetch and normalization

**Files:** `app/adapters/cj/schemas.ts`, `app/adapters/cj/normalize.ts`, tests

**Acceptance criteria:**
- [ ] Zod schemas parse the Task 0 fixtures
- [ ] Unknown/extra fields tolerated; **missing required fields rejected loudly**
- [ ] `NormalizedProduct` contains no CJ-specific field names
- [ ] Option dimensions correctly reconstructed (e.g. Colour × Size → variants)
- [ ] Variant-to-image mapping preserved where CJ provides it
- [ ] Raw payload retained for storage

**Test:** `npm test normalize` against the saved fixtures — including the
20+ variant one. No network access in these tests.

### Task 8 — Import job and product list

**Files:** `worker/handlers/import-product.ts`,
`app/routes/app.products._index.tsx`, `app/routes/app.products.$id.tsx`

**Acceptance criteria:**
- [ ] Merchant pastes a CJ product ID; job enqueued; UI shows progress state
- [ ] `SupplierProduct` + `SupplierVariant` rows created
- [ ] **Idempotent**: importing the same product twice updates, never duplicates
- [ ] Rate limiter respected — importing 5 products does not exceed 1 req/s
- [ ] Failures surface a readable error, not a spinner that never resolves

**Test:** Import a real product. Import it again — confirm no duplicate rows.
Queue 5 imports at once and check timings in the worker log.

> ✅ **First demoable moment.** Show this to the merchants you interviewed.

---

## M3 — Content generation

### Task 9 — Markets and Responsible Person settings

**Files:** `app/routes/app.settings.markets.tsx`,
`app/routes/app.settings.compliance.tsx`

**Acceptance criteria:**
- [ ] Add a market: country, language, currency, VAT rate
- [ ] Define one or more Responsible Persons; assign to markets
- [ ] Exactly one default market enforced
- [ ] Deleting a market with existing listings is blocked with an explanation

**Test:** Create DE, FR, PL markets. Confirm VAT rates persist as basis points.

### Task 10 — Pricing engine (pure functions, no I/O)

**Goal:** The most heavily tested module in the codebase. Pricing bugs are
silent and compound.

**Files:** `app/lib/money.ts`, `app/lib/pricing/engine.ts`,
`app/lib/pricing/engine.test.ts`

**Acceptance criteria:**
- [ ] `calculatePrice(costMinor, currency, rule, market, fxRate)` — pure
- [ ] Multiplier, fixed fee, cost-banded tiers, compare-at price
- [ ] Rounding: `NONE | END_99 | END_95 | NEAREST`
- [ ] VAT: `ADD_VAT` vs `PRICE_IS_GROSS` — **rounding applies to the gross
      price**, since that is what the customer sees
- [ ] `min_margin_minor` floor respected; violation is an explicit result, not
      a silent clamp
- [ ] **≥ 30 test cases**, including: zero cost, 1-minor-unit cost, rounding
      boundaries (e.g. 10.00 → 9.99), tier edges, 27% VAT (HU), 0% VAT
- [ ] No floating-point arithmetic anywhere in the module

**Test:** `npm test pricing`. Property test: output is never below cost when a
minimum margin is set.

### Task 11 — FX rates

**Files:** `worker/handlers/fx-refresh.ts`

**Acceptance criteria:**
- [ ] Daily ECB reference rates fetched and upserted
- [ ] Missing rate for a currency pair fails the price calculation **loudly** —
      never silently falls back to 1.0
- [ ] Weekend/holiday gaps handled by using the most recent prior rate

**Test:** Run the job; assert `FxRate` rows for EUR→USD. Delete today's rate and
confirm pricing surfaces a clear error.

### Task 12 — Claude listing generation

Prompt design is **Phase 5**. This task is the plumbing around it.

**Files:** `app/lib/ai/client.server.ts`, `app/lib/ai/listing-schema.ts`,
`worker/handlers/generate-listing.ts`

**Acceptance criteria:**
- [ ] One job per `(product, market)` — fan out, do not loop inside one job
- [ ] Structured output validated against a Zod schema before any DB write
- [ ] Validation failure retries once with the error fed back, then dead-letters
- [ ] Title length enforced programmatically, not just requested in the prompt
- [ ] `AiGeneration` row written with tokens, cost and latency for **every**
      call, successful or not
- [ ] Prompt caching enabled on the system prompt
- [ ] `prompt_version` recorded, so output can be traced to a prompt revision

**Test:** Generate for a real imported product in DE. Force a schema violation
with a stub response and confirm it retries then dead-letters rather than
writing bad data.

### Task 13 — Compliance draft generation

**Files:** `app/lib/ai/compliance-schema.ts`, `worker/handlers/draft-compliance.ts`

**Acceptance criteria:**
- [ ] Separate job, separate schema, separate prompt from marketing copy
- [ ] Every field written with `provenance = AI_DRAFT`
- [ ] Record always lands `merchant_reviewed_at = NULL`
- [ ] Fields the supplier data cannot support are left **empty**, never invented
- [ ] `completeness` computed from which required fields are populated

**Test:** Run against a product with sparse supplier data. Confirm the model
leaves gaps empty rather than fabricating a manufacturer address. **If it
fabricates, the prompt is wrong and this task is not done.**

### Task 14 — Listing review and edit UI

**Files:** `app/routes/app.products.$id.listing.tsx`,
`app/routes/app.products.$id.compliance.tsx`

**Acceptance criteria:**
- [ ] Side-by-side: raw supplier text vs generated listing
- [ ] All fields editable; editing sets `human_edited = true`
- [ ] AI-drafted compliance fields visually distinct from merchant-entered ones
- [ ] Explicit "I have reviewed this" action sets `merchant_reviewed_at`
- [ ] **Regenerating copy clears the compliance review flag** — the core reason
      these are separate tables
- [ ] Publishing is blocked while `completeness = EMPTY`

**Test:** Generate, edit, approve, regenerate. Confirm the review flag clears.

---

## M4 — Push to Shopify

### Task 15 — Throttle-aware GraphQL client

**Files:** `app/lib/shopify/graphql-client.server.ts` + tests

**Acceptance criteria:**
- [ ] Reads `extensions.cost.throttleStatus` from every response
- [ ] Self-throttles **before** hitting a 429, not in reaction to one
- [ ] Exponential backoff with jitter on throttling
- [ ] `userErrors` treated as failures — a 200 response with userErrors is
      **not** success
- [ ] Per-shop concurrency cap

**Test:** Unit-test the backoff maths with mocked throttle payloads. Then fire
50 mutations against a dev store and confirm zero 429s.

### Task 16 — Product push

**Files:** `worker/handlers/push-product.ts`

**Acceptance criteria:**
- [ ] `productSet` creates the product with full variant matrix in one call
- [ ] Product created as **DRAFT**. Never published automatically. No exceptions.
- [ ] Images uploaded via staged upload and attached; variant images mapped
- [ ] Inventory set at the merchant's location
- [ ] `ProductVariantMap` rows written with Shopify variant and inventory item IDs
- [ ] Re-push updates in place rather than creating a duplicate
- [ ] Partial failure leaves a recoverable state, not half a product

**Test:** Push a 20-variant product to a dev store. Verify in admin: options,
variants, prices, images, stock. Push again; confirm no duplicate.

> ✅ **The MVP's core loop is complete here.** This is what you demo.

---

## M5 — Retention loop

### Task 17 — Monitoring and re-sync

**Files:** `worker/handlers/monitor-sync.ts`,
`app/routes/app.changes.tsx`

**Acceptance criteria:**
- [ ] Scheduled per shop; respects the per-merchant rate limit
- [ ] Diffs supplier cost and stock against `ProductVariantMap`
- [ ] Emits typed `SupplierChangeEvent` rows
- [ ] Cost change recomputes the price through the pricing engine
- [ ] Merchant sees a change list and can apply or dismiss per item
- [ ] Bulk "apply all" available
- [ ] Shops with `uninstalled_at` set are skipped — no wasted API budget

**Test:** Import a product, manually alter the stored cost/stock to simulate a
supplier change, run the job, confirm the event appears and applying it updates
Shopify.

---

## M6 — Launch readiness

### Task 18 — Webhooks and GDPR

**Files:** `app/routes/webhooks.*.tsx`, `worker/handlers/shop-redact.ts`

**Acceptance criteria:**
- [ ] `customers/data_request`, `customers/redact`, `shop/redact` all registered
      and HMAC-verified
- [ ] `app/uninstalled` marks the shop and cancels scheduled work
- [ ] `products/delete` clears `shopify_product_id`
- [ ] All handlers return **200 in under 5 seconds**; work happens in jobs
- [ ] Duplicate deliveries are no-ops (unique constraint on event ID)
- [ ] `shop/redact` hard-deletes every Shop-scoped row

**Test:** Trigger each from the Partner Dashboard. Replay the same event twice
and confirm the second is a no-op. Install then uninstall on a dev store and
verify data is gone.

### Task 19 — Billing and usage metering

**Files:** `app/lib/billing/`, `app/routes/app.billing.tsx`

**Acceptance criteria:**
- [ ] Plans configured in the Partner Dashboard via **Shopify App Pricing**
- [ ] **No `appSubscriptionCreate` call.** Not the legacy Billing API.
- [ ] Plan resolved via Partner API and the `plan_handle` redirect parameter —
      not the removed `charge_id` parameter or subscription webhooks
- [ ] AI generations emit App Events for metered billing
- [ ] Quota enforced **before** the Claude call, not after
- [ ] Merchant sees usage against quota

**Test:** Install on a dev store, subscribe to a test plan, exhaust the quota,
confirm generation is blocked with a clear upgrade path.

### Task 20 — Submission preparation

**Acceptance criteria:**
- [ ] Shopify's automated checks all pass
- [ ] App loads embedded, with no console errors, on a store with 1,000+ products
- [ ] Listing copy, screenshots, demo video, privacy policy, support contact
- [ ] Test store with sample data prepared for the reviewer
- [ ] Onboarding walks a new merchant to first pushed product without support

**Test:** Install on a fresh store as if you were a stranger. Anywhere you have
to explain something to yourself is a place the reviewer will fail you.

---

## If 100–140 hours is too long

The honest cut, in priority order:

1. **Ship one market first.** The schema already supports N markets; the UI and
   fan-out do not have to. Saves ~12h and costs nothing structurally.
2. **Drop cost-banded pricing tiers** (Task 10). Flat multiplier only. Saves ~4h.
3. **Drop bulk apply** in Task 17. Per-item only. Saves ~3h.

Do **not** cut: the pricing engine's test suite, the compliance/listing
separation, or monitoring. Those are, in order, your correctness, your
differentiation, and your revenue.
