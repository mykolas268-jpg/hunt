import { describe, expect, it } from "vitest";
import { addBp, applyBp, convertCurrency, formatMinor, MoneyError, removeBp, roundTo } from "./money.js";

describe("applyBp", () => {
  it("applies a 2x multiplier", () => expect(applyBp(1000, 20000)).toBe(2000));
  it("applies a percentage", () => expect(applyBp(1000, 2100)).toBe(210));
  it("returns zero for zero", () => expect(applyBp(0, 20000)).toBe(0));
  it("rounds half away from zero (positive)", () => expect(applyBp(5, 5000)).toBe(3));
  it("rounds half away from zero (negative)", () => expect(applyBp(-5, 5000)).toBe(-3));
  it("rejects non-integers", () => expect(() => applyBp(10.5, 100)).toThrow(MoneyError));
  it("rejects overflow", () => expect(() => applyBp(Number.MAX_SAFE_INTEGER, 20000)).toThrow(MoneyError));
});

describe("addBp / removeBp", () => {
  it("adds 21% VAT", () => expect(addBp(1000, 2100)).toBe(1210));
  it("adds 27% VAT (Hungary, the EU maximum)", () => expect(addBp(1000, 2700)).toBe(1270));
  it("adds 0% VAT", () => expect(addBp(1000, 0)).toBe(1000));
  it("removes 21% VAT", () => expect(removeBp(1210, 2100)).toBe(1000));
  it("removes 27% VAT", () => expect(removeBp(1270, 2700)).toBe(1000));
  it("round-trips within one minor unit", () => {
    for (const amount of [1, 7, 99, 333, 1050, 99999]) {
      expect(Math.abs(removeBp(addBp(amount, 2100), 2100) - amount)).toBeLessThanOrEqual(1);
    }
  });
  it("refuses a rate that would divide by zero", () => expect(() => removeBp(100, -10000)).toThrow(MoneyError));
});

describe("convertCurrency", () => {
  it("converts at 1.085", () => expect(convertCurrency(1000, 10850)).toBe(1085));
  it("rejects a zero rate", () => expect(() => convertCurrency(1000, 0)).toThrow(MoneyError));
  it("rejects a negative rate", () => expect(() => convertCurrency(1000, -1)).toThrow(MoneyError));
});

describe("roundTo", () => {
  it("NONE leaves the amount alone", () => expect(roundTo(1234, "NONE")).toBe(1234));

  // The documented discontinuity: a whole unit drops to just below it.
  it("END_99 drops a whole unit to .99", () => expect(roundTo(1000, "END_99")).toBe(999));
  it("END_99 rounds up mid-unit", () => expect(roundTo(1050, "END_99")).toBe(1099));
  it("END_99 leaves an exact .99 alone", () => expect(roundTo(1099, "END_99")).toBe(1099));
  it("END_99 steps up from just above a whole unit", () => expect(roundTo(1001, "END_99")).toBe(1099));
  it("END_99 handles a small amount", () => expect(roundTo(50, "END_99")).toBe(99));

  it("END_95 drops a whole unit to .95", () => expect(roundTo(1000, "END_95")).toBe(995));
  it("END_95 rounds up mid-unit", () => expect(roundTo(1050, "END_95")).toBe(1095));
  it("END_95 steps to the next unit when past .95", () => expect(roundTo(1097, "END_95")).toBe(1195));
  it("END_95 leaves an exact .95 alone", () => expect(roundTo(1095, "END_95")).toBe(1095));

  it("NEAREST rounds down", () => expect(roundTo(1049, "NEAREST")).toBe(1000));
  it("NEAREST rounds up", () => expect(roundTo(1050, "NEAREST")).toBe(1100));

  it("leaves zero alone under charm rounding", () => expect(roundTo(0, "END_99")).toBe(0));
  it("never produces a price above the next whole unit", () => {
    for (let amount = 1; amount <= 2000; amount++) {
      const rounded = roundTo(amount, "END_99");
      expect(rounded % 100).toBe(99);
      expect(rounded).toBeGreaterThan(amount - 100);
    }
  });
});

describe("formatMinor", () => {
  it("formats a whole amount", () => expect(formatMinor(1000, "EUR")).toBe("10.00 EUR"));
  it("pads the minor part", () => expect(formatMinor(1005, "EUR")).toBe("10.05 EUR"));
  it("formats a negative amount", () => expect(formatMinor(-1250, "EUR")).toBe("-12.50 EUR"));
});
