import { afterEach, describe, expect, it } from "vitest";
import { formatCount, formatYen, roundToYen, formatJstDateTime } from "./format";

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

describe("formatJstDateTime", () => {
  it("UTCをJST（+9時間）へ変換して YYYY/MM/DD HH:mm で返す", () => {
    expect(formatJstDateTime(new Date("2026-10-08T05:30:00Z"))).toBe("2026/10/08 14:30");
  });

  it("日付をまたぐケース（UTC 15:00以降はJSTで翌日）", () => {
    expect(formatJstDateTime(new Date("2026-10-08T15:00:00Z"))).toBe("2026/10/09 00:00");
    expect(formatJstDateTime(new Date("2026-10-08T14:59:59Z"))).toBe("2026/10/08 23:59");
  });

  it("年をまたぐケース", () => {
    expect(formatJstDateTime(new Date("2025-12-31T18:05:00Z"))).toBe("2026/01/01 03:05");
  });

  it("null / undefined / Invalid Date はnullを返す（Invalid Dateを表示しない）", () => {
    expect(formatJstDateTime(null)).toBeNull();
    expect(formatJstDateTime(undefined)).toBeNull();
    expect(formatJstDateTime(new Date("not a date"))).toBeNull();
  });

  describe("システムタイムゾーンに依存しない", () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it("TZがUTC / Asia/Tokyo / America/Los_Angeles でも同じ結果", () => {
      const results = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map((tz) => {
        process.env.TZ = tz;
        return formatJstDateTime(new Date("2026-10-08T15:00:00Z"));
      });
      expect(results).toEqual(["2026/10/09 00:00", "2026/10/09 00:00", "2026/10/09 00:00"]);
    });
  });
});
