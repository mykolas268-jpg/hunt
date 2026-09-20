/**
 * Deterministic screening of generated copy.
 *
 * The system prompt tells the model not to make medical claims or use
 * trademarked names. This module assumes it sometimes will anyway.
 *
 * A prompt is a strong prior, not an invariant. Anything that would create
 * legal exposure for the merchant — a health claim, someone else's trademark,
 * an unverifiable absolute — gets a mechanical check that does not depend on
 * the model having complied.
 *
 * Scope, stated honestly: the claim patterns are English-language. For other
 * target languages the brand list still applies (proper nouns do not
 * translate) and a small per-language pattern set is used. This is a safety
 * net that catches the common, high-risk cases — not a compliance guarantee,
 * and the merchant review step is not optional because of it.
 */

export type ViolationKind =
  | "MEDICAL_CLAIM"
  | "TRADEMARK"
  | "UNVERIFIABLE_ABSOLUTE"
  | "UNSUPPORTED_CLAIM"
  | "FORMATTING";

export interface Violation {
  kind: ViolationKind;
  field: string;
  match: string;
  message: string;
}

/**
 * Health and medical claims. Selling a wrist brace as something that "treats
 * arthritis" turns a consumer good into a regulated medical device claim.
 */
const MEDICAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(cure[sd]?|curing)\b/i, "claims to cure"],
  [/\b(treat|treats|treating|treatment of)\s+\w+/i, "claims to treat a condition"],
  [/\b(heal|heals|healing)\b/i, "claims to heal"],
  [/\bprevents?\s+(disease|illness|infection|cancer|covid)/i, "claims disease prevention"],
  [/\b(fda|ce)[\s-]?(approved|certified|cleared)\b/i, "claims regulatory approval"],
  [/\bmedical(ly)?[\s-]?grade\b/i, "claims medical grade"],
  [/\b(anti[\s-]?bacterial|antibacterial|antiviral|anti[\s-]?viral)\b/i, "claims antimicrobial action"],
  [/\b(clinically|scientifically)\s+(proven|tested)\b/i, "claims clinical proof"],
  [/\b(relieves?|alleviates?)\s+(pain|arthritis|anxiety|depression)/i, "claims symptom relief"],
  [/\b(detox|detoxif\w+)\b/i, "claims detoxification"],
  [/\bboosts?\s+(immunity|immune system|metabolism)\b/i, "claims physiological effect"],
  // German / French / Dutch / Polish high-risk equivalents.
  [/\b(heilt|heilung|medizinisch geprüft)\b/i, "medical claim (de)"],
  [/\b(guérit|guérison|traite l'arthrite)\b/i, "medical claim (fr)"],
  [/\b(geneest|genezing)\b/i, "medical claim (nl)"],
  [/\b(leczy|uzdrawia)\b/i, "medical claim (pl)"],
];

/**
 * Trademarks that routinely appear in supplier titles. Proper nouns do not
 * translate, so this list is language-independent.
 *
 * Not exhaustive and cannot be — it covers what dropshipping catalogues
 * actually contain. Merchants can extend it per shop.
 */
const DEFAULT_TRADEMARKS = [
  "apple", "iphone", "ipad", "airpods", "macbook", "airtag",
  "samsung", "galaxy", "nike", "adidas", "puma", "reebok", "under armour",
  "gucci", "prada", "chanel", "louis vuitton", "hermes", "rolex", "dior",
  "disney", "marvel", "pixar", "star wars", "pokemon", "nintendo", "playstation",
  "xbox", "lego", "barbie", "hello kitty", "supreme", "north face",
  "dyson", "gopro", "bose", "sony", "jbl", "fitbit", "garmin", "tesla",
  "coca cola", "starbucks", "ikea", "hermès", "yeezy", "crocs", "ugg",
];

/** Absolutes a merchant cannot substantiate if challenged. */
const ABSOLUTE_PATTERNS: Array<[RegExp, string]> = [
  [/\b100%\s+(guaranteed|effective|safe|waterproof)\b/i, "unqualified absolute guarantee"],
  [/\bbest\s+(in the world|on the market|ever)\b/i, "unsubstantiated superlative"],
  // No leading \b: "#" is not a word character, so \b# never matches at the
  // start of a string — which is exactly where a ranking claim tends to sit.
  [/(?:#|\bno\.?\s)\s?1\s+(best|selling|rated|choice)\b/i, "unsubstantiated ranking"],
  [/\blifetime\s+(warranty|guarantee)\b/i, "lifetime warranty the merchant cannot honour"],
  [/\b(unbreakable|indestructible)\b/i, "absolute durability claim"],
  [/\bnever\s+(breaks|fails|wears out)\b/i, "absolute durability claim"],
  [/\brisk[\s-]?free\b/i, "risk-free claim"],
  [/\bmoney[\s-]?back\s+guarantee\b/i, "guarantee the merchant may not offer"],
];

/** Raw HTML tags permitted in a generated description. */
const ALLOWED_TAGS = new Set(["p", "ul", "ol", "li", "strong", "em", "br"]);

export interface ScreenOptions {
  /** Shop-specific additions to the trademark deny-list. */
  extraTrademarks?: string[];
  /** Brands the merchant is actually authorised to sell. */
  allowedTrademarks?: string[];
}

function screenText(field: string, text: string, options: ScreenOptions): Violation[] {
  const violations: Violation[] = [];

  for (const [pattern, message] of MEDICAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      violations.push({ kind: "MEDICAL_CLAIM", field, match: match[0], message });
    }
  }

  for (const [pattern, message] of ABSOLUTE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      violations.push({ kind: "UNVERIFIABLE_ABSOLUTE", field, match: match[0], message });
    }
  }

  const allowed = new Set((options.allowedTrademarks ?? []).map((t) => t.toLowerCase()));
  const trademarks = [...DEFAULT_TRADEMARKS, ...(options.extraTrademarks ?? []).map((t) => t.toLowerCase())];

  for (const brand of trademarks) {
    if (allowed.has(brand)) continue;
    // Word boundaries only, so "applesauce" does not trip the Apple rule.
    const pattern = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const match = text.match(pattern);
    if (match) {
      violations.push({
        kind: "TRADEMARK",
        field,
        match: match[0],
        message: `references the trademark "${brand}"`,
      });
    }
  }

  return violations;
}

function screenHtml(field: string, html: string): Violation[] {
  const violations: Violation[] = [];
  const tagPattern = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

  for (const match of html.matchAll(tagPattern)) {
    const tag = (match[1] as string).toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      violations.push({
        kind: "FORMATTING",
        field,
        match: match[0],
        message: `disallowed HTML tag <${tag}>`,
      });
    }
  }

  if (/<\s*script/i.test(html) || /on\w+\s*=/i.test(html)) {
    violations.push({
      kind: "FORMATTING",
      field,
      match: "script or event handler",
      message: "description contains executable content",
    });
  }

  return violations;
}

export interface ScreenableListing {
  title: string;
  descriptionHtml: string;
  bullets: string[];
  seoTitle: string;
  seoDescription: string;
  tags: string[];
  claims?: Array<{ claim: string; evidence: string }>;
}

/**
 * Screen a generated listing.
 *
 * Returns every violation rather than the first, so a regeneration prompt can
 * name all the problems at once instead of playing whack-a-mole across retries.
 */
export function screenListing(
  listing: ScreenableListing,
  sourceText: string,
  options: ScreenOptions = {},
): Violation[] {
  const violations: Violation[] = [
    ...screenText("title", listing.title, options),
    ...screenText("descriptionHtml", listing.descriptionHtml, options),
    ...screenText("seoTitle", listing.seoTitle, options),
    ...screenText("seoDescription", listing.seoDescription, options),
    ...screenHtml("descriptionHtml", listing.descriptionHtml),
  ];

  listing.bullets.forEach((bullet, i) => {
    violations.push(...screenText(`bullets[${i}]`, bullet, options));
  });

  listing.tags.forEach((tag, i) => {
    violations.push(...screenText(`tags[${i}]`, tag, options));
  });

  // Every spec claim must quote supplier text that actually exists. This is
  // the check that catches invented dimensions, materials and capacities.
  const haystack = normalizeForMatching(sourceText);
  for (const { claim, evidence } of listing.claims ?? []) {
    if (!haystack.includes(normalizeForMatching(evidence))) {
      violations.push({
        kind: "UNSUPPORTED_CLAIM",
        field: "claims",
        match: claim,
        message: `cites evidence not present in the supplier data: "${truncate(evidence, 60)}"`,
      });
    }
  }

  return violations;
}

/**
 * Drop compliance fields whose evidence is absent from the supplier data.
 *
 * A fabricated manufacturer address is a false regulatory declaration made in
 * the merchant's name, so unsupported fields are nulled rather than flagged and
 * kept. An empty field is a visible gap; a plausible wrong one may never be
 * questioned.
 */
export function stripUnevidencedFields<T extends Record<string, unknown>>(
  output: T & { evidence: Record<string, string> },
  requiredFields: readonly string[],
  sourceText: string,
): { cleaned: T; dropped: string[] } {
  const haystack = normalizeForMatching(sourceText);
  const cleaned = { ...output };
  const dropped: string[] = [];

  for (const field of requiredFields) {
    const value = cleaned[field as keyof T];
    if (value == null || value === "") continue;

    const evidence = output.evidence?.[field];
    if (!evidence || !haystack.includes(normalizeForMatching(evidence))) {
      (cleaned as Record<string, unknown>)[field] = null;
      dropped.push(field);
    }
  }

  return { cleaned, dropped };
}

/**
 * Collapse whitespace and case so an evidence quote survives the model
 * reformatting it. Deliberately permissive: the check is for fabrication, not
 * for transcription accuracy.
 */
function normalizeForMatching(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `- ${v.field}: ${v.message} (found: "${truncate(v.match, 40)}")`)
    .join("\n");
}
