# hunt

Shopify app for EU dropshippers: compliant, native-language product listings
imported from CJ Dropshipping.

> **Positioning:** the Shopify dropshipping app for EU sellers — compliant,
> native-language listings from CJ in one click. Chosen over "cheaper AutoDS"
> because Shopify Magic already generates product copy for free and CJ already
> ships a free import app; competing on either alone is competing with free.

## Status

Core libraries are implemented and tested. The Shopify app shell is not, because
it must be scaffolded with the Shopify CLI (see below).

| Area | State |
|---|---|
| Data model + migrations | ✅ Implemented, migrated against Postgres |
| Money / crypto primitives | ✅ Implemented, 54 tests |
| Pricing engine | ✅ Implemented, 43 tests |
| Supplier rate limiter | ✅ Implemented, 14 tests incl. real-Postgres concurrency |
| CJ adapter | ⚠️ Implemented, 46 tests — **schemas unverified against the live API** |
| AI listing + compliance | ✅ Implemented, 57 tests |
| Shopify GraphQL client | ✅ Implemented, 18 tests |
| Queue, worker, job handlers | ✅ Implemented |
| FX rates (ECB) | ✅ Implemented, 13 tests |
| **Shopify app shell / UI routes** | ❌ **Not built — needs `shopify app init`** |
| Product push (`productSet`) | ❌ Not built |
| Billing (Shopify App Pricing) | ❌ Not built |

**251 tests passing.** `npm test`

## Two things to do before trusting any of this

1. **Run the CJ spike** (`npm run spike:cj`). The CJ developer docs were
   unreachable during development, so `app/adapters/cj/schemas.ts` encodes the
   documented v2 shape rather than an observed payload. The spike also answers
   whether API keys are issued **per merchant account** — the assumption the
   BYO-key model, the rate limiter and the monitoring feature all rest on.

2. **Validate the GPSR premise.** Ten conversations with EU dropshippers. The
   entire differentiation assumes they will pay for compliance help, and
   nobody has tested that.

## Getting started

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and ENCRYPTION_KEY
openssl rand -base64 32       # -> ENCRYPTION_KEY
npx prisma migrate deploy
npm test
```

Run the worker:

```bash
npm run worker
```

### Adding the Shopify app shell

The UI is not scaffolded here. Generate it with the official CLI and merge:

```bash
npm init @shopify/app@latest     # choose the React Router template
```

Then copy `app/lib`, `app/adapters`, `worker/` and `prisma/` across. Those are
framework-independent; the routes are not, and hand-written routes would drift
from whatever the template currently generates.

Set `shopify.app.toml` scopes to exactly:

```
write_products,read_locations,write_inventory
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — stack decisions with ADRs, data model,
  OAuth flow, scopes, webhooks, supplier integration design.
- [Build plan](docs/BUILD_PLAN.md) — 20 ordered tasks with acceptance criteria.
- [Launch readiness](docs/LAUNCH.md) — App Store checklist, pricing, unit
  economics, risks.

## Design rules

Three conventions the codebase depends on. Breaking any of them is a bug, not
a style preference.

1. **Money is always an integer of minor units plus a currency code.** No
   `Float`, no `Decimal`, anywhere. Pricing defects are silent and compound.
2. **`Listing` and `ComplianceRecord` are separate tables.** Marketing copy and
   legal declarations have different provenance, liability and review
   lifecycles. Regenerating copy must be able to invalidate a compliance
   review, which one shared row cannot express.
3. **AI output is validated, then screened, then attributed.** Schemas enforce
   what must be true, deterministic guardrails assume the model ignored its
   instructions, and every generated field records its model, prompt version
   and whether a human edited it.

## Scope

**In:** CJ import (merchant's own API key), AI listings with GPSR compliance
fields, VAT-aware pricing rules, price/stock monitoring with one-click re-sync.

**Out:** product research, non-CJ suppliers, any scraping, automated order
fulfillment, AI image generation, analytics, multi-store UI.
