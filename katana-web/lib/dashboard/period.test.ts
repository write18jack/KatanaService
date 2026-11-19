import { describe, expect, it } from "vitest";
import { getRolling30DaysPeriod } from "./period";

describe("getRolling30DaysPeriod", () => {
  it("periodEndは渡したnowそのもの", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    const { periodEnd } = getRolling30DaysPeriod(now);
    expect(periodEnd).toEqual(now);
  });

  it("periodStartはnowから30日前（calendar monthではない）", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    const { periodStart } = getRolling30DaysPeriod(now);
    expect(periodStart).toEqual(new Date("2026-09-08T12:00:00.000Z"));
  });

  it("半開区間として使える（periodStart < periodEnd）", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    const { periodStart, periodEnd } = getRolling30DaysPeriod(now);
    expect(periodStart.getTime()).toBeLessThan(periodEnd.getTime());
  });

  it("nowを省略した場合は現在時刻を使う", () => {
    const before = Date.now();
    const { periodEnd } = getRolling30DaysPeriod();
    const after = Date.now();
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(before);
    expect(periodEnd.getTime()).toBeLessThanOrEqual(after);
  });
});
