/**
 * Language and country names for the EU markets this app targets.
 *
 * The AI prompt needs a human-readable language name — "German", not "de".
 * Passing the ISO code invites the model to guess, and a listing generated in
 * the wrong language is worse than a failed generation because it looks fine.
 *
 * Deliberately narrow: only the markets in scope. Adding a country here is a
 * one-line change; silently falling back to English is not something the
 * merchant would ever be told about, so unknown codes raise instead.
 */

export const LANGUAGE_NAMES: Record<string, string> = {
  bg: "Bulgarian", cs: "Czech", da: "Danish", de: "German", el: "Greek",
  en: "English", es: "Spanish", et: "Estonian", fi: "Finnish", fr: "French",
  ga: "Irish", hr: "Croatian", hu: "Hungarian", it: "Italian", lt: "Lithuanian",
  lv: "Latvian", mt: "Maltese", nl: "Dutch", pl: "Polish", pt: "Portuguese",
  ro: "Romanian", sk: "Slovak", sl: "Slovenian", sv: "Swedish",
};

export const COUNTRY_NAMES: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DK: "Denmark", EE: "Estonia", ES: "Spain", FI: "Finland",
  FR: "France", GR: "Greece", HR: "Croatia", HU: "Hungary", IE: "Ireland",
  IT: "Italy", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", MT: "Malta",
  NL: "Netherlands", PL: "Poland", PT: "Portugal", RO: "Romania",
  SE: "Sweden", SI: "Slovenia", SK: "Slovakia",
};

export class UnknownLocaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownLocaleError";
  }
}

export function languageName(code: string): string {
  const name = LANGUAGE_NAMES[code.toLowerCase()];
  if (!name) {
    throw new UnknownLocaleError(
      `Unsupported language code "${code}". Add it to LANGUAGE_NAMES rather than letting generation fall back to English.`,
    );
  }
  return name;
}

export function countryName(code: string): string {
  const name = COUNTRY_NAMES[code.toUpperCase()];
  if (!name) {
    throw new UnknownLocaleError(
      `Unsupported country code "${code}". Add it to COUNTRY_NAMES before selling into this market.`,
    );
  }
  return name;
}
