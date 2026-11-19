import { afterEach, describe, expect, it } from "vitest";
import { getLastCompletedMonthEnds } from "./trendPeriod";

const labels = (now: string) => getLastCompletedMonthEnds(new Date(now)).map((m) => m.label);
const asOfIso = (now: string) => getLastCompletedMonthEnds(new Date(now)).map((m) => m.asOf.toISOString());

describe("getLastCompletedMonthEnds", () => {
  it("12点を古い月から新しい月の順で返す", () => {
    const result = getLastCompletedMonthEnds(new Date("2026-10-10T03:00:00Z"));
    expect(result).toHaveLength(12);
    const times = result.map((m) => m.asOf.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("2026年10月 → 2025年10月〜2026年9月（現在月を含めない）", () => {
    expect(labels("2026-10-10T03:00:00Z")).toEqual([
      "2025/10", "2025/11", "2025/12", "2026/01", "2026/02", "2026/03",
      "2026/04", "2026/05", "2026/06", "2026/07", "2026/08", "2026/09",
    ]);
  });

  it("各Snapshotは月末23:59:59.999 JST（= 翌月1日00:00 JST − 1ms）のUTC時刻になる", () => {
    const result = asOfIso("2026-10-10T03:00:00Z");
    expect(result[11]).toBe("2026-09-30T14:59:59.999Z");
    expect(result[10]).toBe("2026-08-31T14:59:59.999Z");
    expect(result[0]).toBe("2025-10-31T14:59:59.999Z");
  });

  it("年またぎ: 2026年1月 → 2025年1月〜2025年12月", () => {
    const result = getLastCompletedMonthEnds(new Date("2026-01-15T03:00:00Z"));
    expect(result[0].label).toBe("2025/01");
    expect(result[11].label).toBe("2025/12");
    expect(result[11].asOf.toISOString()).toBe("2025-12-31T14:59:59.999Z");
  });

  it("2月末（平年）は28日", () => {
    const feb = getLastCompletedMonthEnds(new Date("2026-03-10T03:00:00Z"))[11];
    expect(feb.label).toBe("2026/02");
    expect(feb.asOf.toISOString()).toBe("2026-02-28T14:59:59.999Z");
  });

  it("うるう年の2月末は29日", () => {
    const feb = getLastCompletedMonthEnds(new Date("2028-03-10T03:00:00Z"))[11];
    expect(feb.label).toBe("2028/02");
    expect(feb.asOf.toISOString()).toBe("2028-02-29T14:59:59.999Z");
  });

  it("JST月初境界: 10月1日00:00 JSTちょうどで9月が確定済みになる", () => {
    // 2026-09-30T15:00:00Z = 2026-10-01 00:00 JST
    expect(labels("2026-09-30T15:00:00.000Z")[11]).toBe("2026/09");
    // その1ms前はまだ9月（進行中）なので最新は8月
    expect(labels("2026-09-30T14:59:59.999Z")[11]).toBe("2026/08");
  });

  it("UTCとJSTで日付（月）が異なる時刻はJSTの月で判定する", () => {
    // UTCでは9月30日20時だが、JSTでは10月1日05時 → 現在月は10月
    expect(labels("2026-09-30T20:00:00Z")[11]).toBe("2026/09");
    // UTCでは12月31日18時だが、JSTでは翌年1月1日03時 → 12月が確定済み
    expect(labels("2025-12-31T18:00:00Z")[11]).toBe("2025/12");
  });

  describe("システムタイムゾーンに依存しない", () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it("TZがUTC / Asia/Tokyo / America/Los_Angeles / Pacific/Kiritimati でも同じ結果", () => {
      const now = "2026-09-30T20:00:00Z";
      const results = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"].map((tz) => {
        process.env.TZ = tz;
        return JSON.stringify({ labels: labels(now), asOf: asOfIso(now) });
      });
      expect(new Set(results).size).toBe(1);
      expect(JSON.parse(results[0]).asOf[11]).toBe("2026-09-30T14:59:59.999Z");
    });
  });
});
