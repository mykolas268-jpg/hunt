# Phase 6 — Launch readiness

Everything below marked **estimate** is a calculation from stated assumptions,
not a measurement. The assumptions are written out so you can replace them with
real numbers once you have them, rather than inheriting my guesses silently.

---

## 1. Shopify App Store review checklist

### Blocking — the app cannot be listed without these

- [ ] **OAuth completes cleanly.** Install immediately redirects into the app,
      with no interstitial screen before authentication.
- [ ] **Scopes match what the app actually uses.** Declared:
      `write_products`, `read_locations`, `write_inventory`. Nothing else.
      Shopify restricts scopes an app cannot justify.
- [ ] **All three compliance webhooks registered and HMAC-verified**:
      `customers/data_request`, `customers/redact`, `shop/redact`.
      These are the most common automated-check failure.
- [ ] **Every webhook returns 200 within 5 seconds.** Receive, verify, enqueue,
      respond. No supplier calls or AI calls inline.
- [ ] **Billing through Shopify App Pricing.** Off-platform billing is
      prohibited. Do **not** call `appSubscriptionCreate` — that is the legacy
      Billing API path.
- [ ] **Embedded with App Bridge**, loading `app-bridge.js` before any other
      script tag.
- [ ] **Latest App Bridge, current API version.** Shopify deprecates versions
      on a schedule; an app on an expired version fails review.
- [ ] **No console errors** on any screen in the embedded admin.
- [ ] **Privacy policy URL** that actually describes what you store — the CJ
      credentials and the product data.
- [ ] **Working support contact** that a human answers.

### Quality — these decide whether the review is quick or painful

- [ ] Tested on a store with 1,000+ products. Reviewers do this.
- [ ] Onboarding takes a new merchant to a first pushed product without help.
- [ ] Demo store prepared with sample data and CJ already connected.
- [ ] Screenshots and a demo video showing the actual flow, not marketing art.
- [ ] Uninstall and reinstall leaves no broken state.
- [ ] Every error message says what to do next, not just what failed.

### Specific to this app

- [ ] **Never claim to provide compliance.** The listing copy, the UI and the
      support docs must say the app *assists with* GPSR data, and that the
      merchant is responsible for accuracy. Claiming to make a merchant
      compliant is both false and the fastest route to a liability you cannot
      insure against.
- [ ] **AI-drafted compliance fields visibly marked as drafts** requiring
      review, in the UI itself and not only in documentation.
- [ ] **Products are created as drafts.** A reviewer who finds an app
      publishing to a live storefront without consent will fail it.

---

## 2. Pricing model

### Meter generations, not products

The instinct is to price by product count. That is wrong here, because the cost
driver is **one AI generation per product per market**. A merchant importing 50
products into four markets costs four times one importing 50 into one market,
at the same product count. Pricing by product would hand your worst unit
economics to your most enthusiastic users.

So: **one credit = one listing generation for one market.** Compliance drafting
is bundled with it, since the two always run together.

### Tiers

| | **Starter** | **Growth** | **Scale** |
|---|---|---|---|
| Price | **€19/mo** | **€39/mo** | **€79/mo** |
| Generation credits | 120 | 240 | 500 |
| Markets | 1 | 3 | Unlimited |
| Monitored products | 100 | 500 | 2,000 |
| Monitoring frequency | Daily | Daily | 4x daily |
| Overage | — | €0.15/credit | €0.12/credit |

- **14-day free trial**, configured in the Partner Dashboard. No card logic in
  your code.
- Credits do not roll over. Rollover turns a predictable monthly cost into an
  unbounded liability you have already been paid for.
- Overage on the two upper tiers only. A Starter user who hits the cap should
  upgrade, not accumulate a surprise bill.

### Implementation

Shopify App Pricing, not the Billing API. Plans, prices and trials live in the
Partner Dashboard; your app writes no billing code. Two consequences of the
**28 April 2026** changes that are already in effect:

- Subscription webhooks are no longer sent → resolve plan state via the Partner API.
- `charge_id` is no longer appended to redirect URLs → use `plan_handle`.

Metered usage goes through the **App Events API**: emit an event per
generation, define the meter in the dashboard, Shopify aggregates and invoices.

**Enforce the quota before the Claude call, never after.** Checking afterwards
means you have already paid for work you cannot bill.

---

## 3. Unit economics

### Cost per generation — estimate

Assumptions, all replaceable with measurements:

| Input | Value | Source |
|---|---|---|
| System prompt (cached) | ~1,100 tokens | measured from `prompts.ts` |
| Variable input | ~400 tokens | supplier data, typical |
| Output | ~900 tokens | schema-bounded |
| Model | `claude-opus-5` | $5/M in, $25/M out, $0.50/M cache read |
| Guardrail retry rate | 15% | **assumption — unmeasured** |

Listing generation, per call:

```
  400 uncached in  x $5.00/M  = $0.0020
1,100 cached in    x $0.50/M  = $0.00055
  900 out          x $25.00/M = $0.0225
                               ---------
                                $0.0251
```

Compliance drafting runs at `high` effort on a similar payload: **~$0.020**.

**Per credit: ($0.025 + $0.020) x 1.15 retry factor ≈ $0.052**

Prompt caching saves roughly $0.005 per call — about 10%. Worth having, not
transformative. The output tokens dominate, and they are irreducible.

### Cost per user per month — estimate

| Item | Starter | Growth | Scale |
|---|---|---|---|
| AI, at full credit usage | $6.24 | $12.48 | $26.00 |
| Hosting (Railway, amortised at 100 users) | $0.60 | $0.60 | $0.60 |
| Supplier API | $0.00 | $0.00 | $0.00 |
| Shopify revenue share (first $1M) | $0.00 | $0.00 | $0.00 |
| **Total COGS** | **$6.84** | **$13.08** | **$26.60** |
| Revenue (approx. USD) | $20.50 | $42.00 | $85.00 |
| **Gross margin** | **67%** | **69%** | **69%** |

Credit caps were chosen to hold COGS near 30% of revenue, which is why the
margin stays flat across tiers rather than collapsing at the top. That is the
whole reason to cap credits at all.

**Two things this table is not telling you:**

1. **Full credit usage is the worst case.** Real average usage will be lower —
   most merchants will not exhaust their allowance — so realised margin will be
   better. Do not plan on it; plan on the worst case and be pleasantly wrong.
2. **Your time is not in it.** At 10 hours a week of support and development,
   a €5,000/month business is paying you roughly €12/hour. The margin
   percentage is healthy; the absolute number is what decides whether this is
   worth doing.

### Break-even

Fixed monthly costs: Railway ~$25, domain and email ~$5, Shopify Partner €0.
Call it **$35/month**.

At Growth tier, contribution per user is roughly $29. **Two paying customers
cover infrastructure.** That is genuinely encouraging and it is the strongest
argument for building this: the financial downside is small.

### The number that actually matters

| Paying users | MRR (Growth mix) | Monthly contribution |
|---|---|---|
| 10 | €390 | ~€270 |
| 50 | €1,950 | ~€1,350 |
| 200 | €7,800 | ~€5,400 |
| 500 | €19,500 | ~€13,500 |

**50 users is a side income. 200 is a job. 500 is a business.**

And the trap underneath it: **dropshipping tools churn hard, because
dropshippers quit.** At an assumed 10% monthly churn (*assumption — measure
yours*), holding 200 users means acquiring 20 new ones every month, forever.
Holding 500 means 50 a month. Acquisition, not the product, is what this
business runs on — and nothing in this codebase helps with that.

---

## 4. Top 5 risks

### 1. The GPSR demand assumption is wrong

**Probability: high. Impact: fatal.** Still unvalidated after six phases. If
EU dropshippers ignore GPSR and intend to keep ignoring it, the differentiation
is worthless and you are competing with free tools on features.

**Mitigation:** the 10-merchant interview, before Task 9. One week, €0. If
fewer than 3 of 10 describe GPSR as a real problem, pivot to Angle B (listing
quality depth) — the codebase supports it, only the prompts and the compliance
UI change. The schema separation you already have makes that pivot cheap.

### 2. Distribution, not product

**Probability: very high. Impact: severe.** A new Shopify app with no reviews
ranks nowhere. Merchants search "dropshipping", find DSers and AutoDS with tens
of thousands of reviews, and never scroll to you. This kills more solo Shopify
apps than any technical problem, and building a better product does not fix it.

**Mitigation:** do not rely on App Store search. Pick one channel and work it
before launch — EU dropshipping communities, a German or Polish YouTube
creator, SEO content on GPSR compliance that ranks because nobody else writes
it. Get your first 20 users by hand. If you cannot get 20 by hand, the App
Store will not save you.

### 3. Single-supplier dependency

**Probability: medium. Impact: severe.** Everything routes through CJ. They can
change their API, restrict access, price it, or ship EU compliance themselves —
they already have a Shopify app and a direct relationship with your users.

**Mitigation:** the `SupplierAdapter` seam is already in place, so a second
supplier is a new file. Do not build one speculatively. But do monitor CJ's
changelog, and treat "CJ announces a compliance feature" as a trigger to
reassess rather than a surprise.

### 4. Compliance liability

**Probability: low. Impact: existential.** A merchant is fined, or a product
injures someone, and their lawyer looks at the tool that generated the safety
warnings.

**Mitigation:** already partly built — evidence-backed extraction, AI drafts
that cannot auto-publish, mandatory merchant review, fields left empty rather
than invented. Add: explicit terms disclaiming compliance responsibility,
never using the word "compliant" in marketing, an audit trail of who reviewed
what and when, and professional indemnity insurance before your first paying
customer. **Talk to a lawyer about this one specifically.** It is the single
place where being wrong costs more than the business is worth.

### 5. Churn outrunning acquisition

**Probability: high. Impact: severe.** Covered above: your customers' own
businesses fail at a high rate, and they take your subscription with them.

**Mitigation:** the monitoring feature is your best defence, because it creates
a reason to open the app after import. Beyond that: annual plans at a discount
to lock in revenue, and measure cohort retention from month one so you know
your real number instead of my assumed 10%. If month-3 retention is under 50%,
fix retention before spending anything on acquisition.

---

## 5. Sequencing before launch

1. **Task 0 spike** — 3–5 hours. Gates the architecture.
2. **10-merchant GPSR interview** — 1 week. Gates the entire premise.
3. Build M1–M4. First demoable product.
4. **Show it to the same 10 merchants.** Not a survey — watch them use it.
5. Build M5–M6.
6. **Hand-recruit 20 users** before App Store submission.
7. Submit.

Steps 2, 4 and 6 are the ones a technical founder skips because they are
uncomfortable, and they are the ones that decide whether this works.
