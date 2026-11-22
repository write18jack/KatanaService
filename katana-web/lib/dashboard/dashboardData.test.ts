import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { product: { count: vi.fn() } },
}));
vi.mock("@/lib/market-analytics/currentMetrics", () => ({
  getMarketInventoryCount: vi.fn(),
  getAveragePrice: vi.fn(),
  getMedianPrice: vi.fn(),
}));
vi.mock("@/lib/market-analytics/soldMetrics", () => ({
  getSoldCount: vi.fn(),
}));
vi.mock("@/lib/market-analytics/priceTrend", () => ({
  getPriceTrend: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getAveragePrice, getMarketInventoryCount, getMedianPrice } from "@/lib/market-analytics/currentMetrics";
import { getPriceTrend } from "@/lib/market-analytics/priceTrend";
import { getSoldCount } from "@/lib/market-analytics/soldMetrics";
import type { MarketFilters } from "@/lib/market-analytics/types";
import { getDashboardMarketSummary, getDashboardPriceTrend, getOwnShopProductCounts } from "./dashboardData";
import { formatCount, formatYen } from "./format";
import { resolveMarketFilters, type MarketFilterMasterOptions } from "./marketFilters";

const period = {
  periodStart: new Date("2026-09-09T00:00:00Z"),
  periodEnd: new Date("2026-10-09T00:00:00Z"),
};

const masters: MarketFilterMasterOptions = {
  categoryId: [{ id: "cat-1", name: "刀" }],
  gradeId: [{ id: "grade-1", name: "特別保存刀剣" }],
  rankId: [],
  periodId: [],
  provinceId: [{ id: "province-1", name: "備前" }],
  swordEraId: [],
  makerId: [],
  appraiserId: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMarketInventoryCount).mockResolvedValue(0);
  vi.mocked(getAveragePrice).mockResolvedValue({
    averagePrice: null,
    disclosedPriceCount: 0,
    totalInventoryCount: 0,
  });
  vi.mocked(getMedianPrice).mockResolvedValue(null);
  vi.mocked(getSoldCount).mockResolvedValue(0);
  vi.mocked(prisma.product.count).mockResolvedValue(0);
  vi.mocked(getPriceTrend).mockImplementation(async (_filters: MarketFilters, dates: Date[]) =>
    dates.map((date, i) => ({
      date,
      inventoryCount: 20 + i,
      disclosedPriceCount: i === 2 ? 0 : 10 + i,
      averagePrice: i === 2 ? null : 1_000_000 + i,
      medianPrice: i === 2 ? null : 900_000 + i,
    })),
  );
});

const now = new Date("2026-10-10T03:00:00Z");

describe("getDashboardMarketSummary", () => {
  it("4つの市場KPIすべてに同じfiltersを渡す", async () => {
    const { filters } = resolveMarketFilters({ categoryId: "cat-1", gradeId: "grade-1" }, masters);

    await getDashboardMarketSummary(filters, period);

    expect(getMarketInventoryCount).toHaveBeenCalledWith(filters);
    expect(getAveragePrice).toHaveBeenCalledWith(filters);
    expect(getMedianPrice).toHaveBeenCalledWith(filters);
    expect(getSoldCount).toHaveBeenCalledWith(filters, period.periodStart, period.periodEnd);
  });

  it("無効条件を含むURLでもクラッシュせず、有効なfiltersのみ渡す", async () => {
    const { filters, invalidKeys } = resolveMarketFilters(
      { categoryId: "cat-1", gradeId: "unknown", provinceId: ["province-1", "province-1"], rankId: "" },
      masters,
    );

    await expect(getDashboardMarketSummary(filters, period)).resolves.toBeDefined();
    expect(invalidKeys.sort()).toEqual(["gradeId", "provinceId", "rankId"]);
    expect(getMarketInventoryCount).toHaveBeenCalledWith({ categoryId: "cat-1" });
    expect(getSoldCount).toHaveBeenCalledWith({ categoryId: "cat-1" }, period.periodStart, period.periodEnd);
  });

  it("0件時は既存の表示（0振 / —）になる値をそのまま返す", async () => {
    const summary = await getDashboardMarketSummary({}, period);

    expect(formatCount(summary.inventoryCount)).toBe("0振");
    expect(formatYen(summary.average.averagePrice)).toBe("—");
    expect(formatYen(summary.medianPrice)).toBe("—");
    expect(formatCount(summary.soldCount)).toBe("0振");
  });
});

describe("getOwnShopProductCounts", () => {
  it("自店のACTIVE/SOLD件数はshopIdとstatusのみで限定し、市場フィルターを適用しない", async () => {
    vi.mocked(prisma.product.count).mockResolvedValueOnce(128).mockResolvedValueOnce(32);

    const counts = await getOwnShopProductCounts("shop-1");

    expect(counts).toEqual({ activeCount: 128, soldCount: 32 });
    expect(prisma.product.count).toHaveBeenCalledTimes(2);
    expect(prisma.product.count).toHaveBeenNthCalledWith(1, { where: { shopId: "shop-1", status: "ACTIVE" } });
    expect(prisma.product.count).toHaveBeenNthCalledWith(2, { where: { shopId: "shop-1", status: "SOLD" } });
  });
});

describe("getDashboardPriceTrend", () => {
  it("直近12か月のJST月末Snapshot日時を古い順にgetPriceTrendへ渡す", async () => {
    await getDashboardPriceTrend({}, now);

    expect(getPriceTrend).toHaveBeenCalledTimes(1);
    const dates = vi.mocked(getPriceTrend).mock.calls[0][1];
    expect(dates).toHaveLength(12);
    expect(dates[0].toISOString()).toBe("2025-10-31T14:59:59.999Z");
    expect(dates[11].toISOString()).toBe("2026-09-30T14:59:59.999Z");
  });

  it("4 KPIとチャートが同じMarketFiltersを使用する", async () => {
    const { filters } = resolveMarketFilters(
      { categoryId: "cat-1", gradeId: "grade-1", provinceId: "province-1" },
      masters,
    );

    await Promise.all([getDashboardMarketSummary(filters, period), getDashboardPriceTrend(filters, now)]);

    expect(vi.mocked(getPriceTrend).mock.calls[0][0]).toBe(filters);
    expect(getMarketInventoryCount).toHaveBeenCalledWith(filters);
    expect(getAveragePrice).toHaveBeenCalledWith(filters);
    expect(getMedianPrice).toHaveBeenCalledWith(filters);
    expect(getSoldCount).toHaveBeenCalledWith(filters, period.periodStart, period.periodEnd);
  });

  it("URLフィルターが変わると、チャートも新しいfiltersで取得される", async () => {
    const first = resolveMarketFilters({ categoryId: "cat-1" }, masters).filters;
    const second = resolveMarketFilters({ categoryId: "cat-1", gradeId: "grade-1" }, masters).filters;

    await getDashboardPriceTrend(first, now);
    await getDashboardPriceTrend(second, now);

    expect(vi.mocked(getPriceTrend).mock.calls[0][0]).toEqual({ categoryId: "cat-1" });
    expect(vi.mocked(getPriceTrend).mock.calls[1][0]).toEqual({ categoryId: "cat-1", gradeId: "grade-1" });
  });

  it("無効フィルターはチャートにも渡さない", async () => {
    const { filters, invalidKeys } = resolveMarketFilters(
      { categoryId: "cat-1", gradeId: "unknown", rankId: ["a", "b"] },
      masters,
    );

    await getDashboardPriceTrend(filters, now);

    expect(invalidKeys.sort()).toEqual(["gradeId", "rankId"]);
    expect(vi.mocked(getPriceTrend).mock.calls[0][0]).toEqual({ categoryId: "cat-1" });
  });

  it("Phase 2の集計値をラベル付きでそのまま返し、nullは0にしない", async () => {
    const data = await getDashboardPriceTrend({}, now);

    expect(data).toHaveLength(12);
    expect(data[0]).toEqual({
      label: "2025/10",
      averagePrice: 1_000_000,
      medianPrice: 900_000,
      inventoryCount: 20,
      disclosedPriceCount: 10,
    });
    expect(data[2]).toMatchObject({ label: "2025/12", averagePrice: null, medianPrice: null, inventoryCount: 22 });
    expect(data[11].label).toBe("2026/09");
  });

  it("チャート取得は自店商品件数のqueryを発行しない（自店サマリーと独立）", async () => {
    await getDashboardPriceTrend({ categoryId: "cat-1" }, now);
    expect(prisma.product.count).not.toHaveBeenCalled();
  });
});
