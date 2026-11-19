import { prisma } from "@/lib/prisma";
import { getAveragePrice, getMarketInventoryCount, getMedianPrice } from "@/lib/market-analytics/currentMetrics";
import { getPriceTrend } from "@/lib/market-analytics/priceTrend";
import { getSoldCount } from "@/lib/market-analytics/soldMetrics";
import type { MarketAverageResult, MarketFilters } from "@/lib/market-analytics/types";
import { toPriceTrendChartData, type PriceTrendChartPoint } from "./priceTrendChart";
import { getLastCompletedMonthEnds } from "./trendPeriod";

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
 * 相場推移チャート用に、直近12か月の確定済み月末Snapshot（JST基準）を取得する。
 * 4 KPIと同じ検証済みMarketFiltersを受け取り、集計はPhase 2のgetPriceTrendへ委譲する
 * （Snapshot SQLや平均・中央値の計算をDashboard側で再実装しない）。
 */
export async function getDashboardPriceTrend(
  filters: MarketFilters,
  now: Date = new Date(),
): Promise<PriceTrendChartPoint[]> {
  const monthEnds = getLastCompletedMonthEnds(now);
  const points = await getPriceTrend(
    filters,
    monthEnds.map((monthEnd) => monthEnd.asOf),
  );

  return toPriceTrendChartData(
    points,
    monthEnds.map((monthEnd) => monthEnd.label),
  );
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
