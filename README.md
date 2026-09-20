# hunt

Shopify app for EU dropshippers: compliant, native-language product listings
imported from CJ Dropshipping.

**Status:** design phase. No application code yet.

- [Architecture](docs/ARCHITECTURE.md) — stack decisions, data model, OAuth flow,
  scopes, webhooks, supplier integration design.

## Scope (MVP)

1. CJ product import (merchant brings their own CJ API key)
2. AI listing generation, EU-localized + GPSR-aware compliance fields
3. Pricing rules engine (VAT-aware)
4. Price & stock change monitoring with one-click re-sync

Explicitly out of scope: product research, non-CJ suppliers, any scraping,
automated order fulfillment, AI image generation, analytics.
