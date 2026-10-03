import { prisma } from "@/lib/prisma";
import { marketFilterWhere } from "./filters";
import type { MarketFilters } from "./types";

/**
 * 指定期間[periodStart, periodEnd)中にSOLDになった商品数（半開区間）。
 * soldAt = periodStart は含み、soldAt = periodEnd は含まない。
 * 「直近30日」等の期間定義はBackend側でハードコードせず、呼び出し側が
 * periodStart/periodEndを明示的に渡す。
 */
export async function getSoldCount(
  filters: MarketFilters,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  return prisma.product.count({
    where: {
      status: "SOLD",
      soldAt: { gte: periodStart, lt: periodEnd },
      shop: { isActive: true },
      ...marketFilterWhere(filters),
    },
  });
}
