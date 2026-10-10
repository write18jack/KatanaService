import { prisma } from "@/lib/prisma";
import { getAveragePrice, getMarketInventoryCount, getMedianPrice } from "@/lib/market-analytics/currentMetrics";
import { getSoldCount } from "@/lib/market-analytics/soldMetrics";
import type { MarketAverageResult, MarketFilters } from "@/lib/market-analytics/types";

export type DashboardMarketSummary = {
  inventoryCount: number;
  average: MarketAverageResult;
  medianPrice: number | null;
  soldCount: number;
};

/**
 * 市場KPI 4指標を、検証済みの同一MarketFiltersで並列取得する。
 * where条件はDashboard側で再実装せず、Phase 2のMarket Analytics関数へ委譲する。
 */
export async function getDashboardMarketSummary(
  filters: MarketFilters,
  period: { periodStart: Date; periodEnd: Date },
): Promise<DashboardMarketSummary> {
  const [inventoryCount, average, medianPrice, soldCount] = await Promise.all([
    getMarketInventoryCount(filters),
    getAveragePrice(filters),
    getMedianPrice(filters),
    getSoldCount(filters, period.periodStart, period.periodEnd),
  ]);

  return { inventoryCount, average, medianPrice, soldCount };
}

/**
 * 自店の商品件数（販売中 / SOLD）。
 * 市場分析とは別責務のため市場フィルターは受け取らず、server-sideのshopIdのみで限定する。
 */
export async function getOwnShopProductCounts(
  shopId: string,
): Promise<{ activeCount: number; soldCount: number }> {
  const [activeCount, soldCount] = await Promise.all([
    prisma.product.count({ where: { shopId, status: "ACTIVE" } }),
    prisma.product.count({ where: { shopId, status: "SOLD" } }),
  ]);

  return { activeCount, soldCount };
}
