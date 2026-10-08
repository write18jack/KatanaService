import { describe, expect, it } from "vitest";
import { formatCount, formatYen, roundToYen } from "./format";

describe("roundToYen", () => {
  it("小数点以下第1位が4以下は切り下げる", () => {
    expect(roundToYen(1320000.4)).toBe(1320000);
  });

  it("小数点以下第1位が5以上は切り上げる（最も近い1円への四捨五入）", () => {
    expect(roundToYen(1320000.5)).toBe(1320001);
  });

  it("整数はそのまま返す", () => {
    expect(roundToYen(1320000)).toBe(1320000);
  });
});

describe("formatYen", () => {
  it("nullは価格データなしを示す「—」になる（¥0ではない）", () => {
    expect(formatYen(null)).toBe("—");
  });

  it("整数の金額を¥区切り文字列にする", () => {
    expect(formatYen(1320000)).toBe("¥1,320,000");
  });

  it("小数の金額は四捨五入してから整形する", () => {
    expect(formatYen(1320000.5)).toBe("¥1,320,001");
  });

  it("0円は¥0として表示する（nullとは区別する）", () => {
    expect(formatYen(0)).toBe("¥0");
  });
});

describe("formatCount", () => {
  it("件数を「振」単位の区切り文字列にする", () => {
    expect(formatCount(1248)).toBe("1,248振");
  });

  it("0件も正常な状態として表示する", () => {
    expect(formatCount(0)).toBe("0振");
  });
});
