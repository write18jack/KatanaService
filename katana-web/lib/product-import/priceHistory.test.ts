import { describe, expect, it } from "vitest";
import { shouldRecordPriceChange } from "./priceHistory";

describe("shouldRecordPriceChange", () => {
  it("新規 + priceあり → 記録する", () => {
    expect(shouldRecordPriceChange(null, 1000)).toBe(true);
  });

  it("新規 + price null → 記録しない", () => {
    expect(shouldRecordPriceChange(null, null)).toBe(false);
  });

  it("null → price → 記録する", () => {
    expect(shouldRecordPriceChange(null, 1500000)).toBe(true);
  });

  it("price A → price B → 記録する", () => {
    expect(shouldRecordPriceChange(1500000, 1400000)).toBe(true);
  });

  it("price A → null → 記録する", () => {
    expect(shouldRecordPriceChange(1500000, null)).toBe(true);
  });

  it("null → null → 記録しない", () => {
    expect(shouldRecordPriceChange(null, null)).toBe(false);
  });

  it("price A → 同じprice A → 記録しない", () => {
    expect(shouldRecordPriceChange(1500000, 1500000)).toBe(false);
  });
});
