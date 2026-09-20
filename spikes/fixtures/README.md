# Supplier payload fixtures

`cj-product-24-variants.json` is a **synthetic** fixture, hand-built to exercise
the multi-dimension option matrix (4 colours x 6 sizes). It is not a payload
observed from the live CJ API.

Build-plan Task 0 replaces it. Capture real responses here, run the adapter
tests against them, and correct `app/adapters/cj/schemas.ts` wherever the real
shape diverges. Until that has happened, treat the CJ adapter as unproven.

Real captures containing account identifiers should be saved as
`*.local.json`, which `.gitignore` excludes.
