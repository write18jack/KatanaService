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

import { prisma } from "@/lib/prisma";
import { getAveragePrice, getMarketInventoryCount, getMedianPrice } from "@/lib/market-analytics/currentMetrics";
import { getSoldCount } from "@/lib/market-analytics/soldMetrics";
import { getDashboardMarketSummary, getOwnShopProductCounts } from "./dashboardData";
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
});

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
