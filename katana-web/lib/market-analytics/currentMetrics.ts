import { prisma } from "@/lib/prisma";
import { marketFilterSql, marketFilterWhere } from "./filters";
import type { MarketAverageResult, MarketFilters } from "./types";
import { toNullableNumber } from "./types";

/**
 * 現在販売中（ACTIVE）の市場在庫総数。price=nullの商品も含む。
 */
export async function getMarketInventoryCount(filters: MarketFilters): Promise<number> {
  return prisma.product.count({
    where: {
      status: "ACTIVE",
      shop: { isActive: true },
      ...marketFilterWhere(filters),
    },
  });
}

/**
 * 現在販売中で価格が公開されている商品の算術平均。
 * 価格公開商品が0件の場合はaveragePrice=null。
 * totalInventoryCountにはprice=nullの商品も含む。
 */
export async function getAveragePrice(filters: MarketFilters): Promise<MarketAverageResult> {
  const baseWhere = {
    status: "ACTIVE" as const,
    shop: { isActive: true },
    ...marketFilterWhere(filters),
  };

  const [totalInventoryCount, agg] = await Promise.all([
    prisma.product.count({ where: baseWhere }),
    prisma.product.aggregate({
      where: { ...baseWhere, price: { not: null } },
      _avg: { price: true },
      _count: { price: true },
    }),
  ]);

  const disclosedPriceCount = agg._count.price;

  return {
    averagePrice: disclosedPriceCount === 0 ? null : toNullableNumber(agg._avg.price),
    disclosedPriceCount,
    totalInventoryCount,
  };
}

/**
 * 現在販売中で価格が公開されている商品の中央値。
 * 母集団はgetAveragePriceと完全に同じ（ACTIVE AND price IS NOT NULL AND Shop.isActive）。
 * PrismaにはPERCENTILE_CONTの標準機能がないため、安全なparameterized $queryRawを使用する。
 */
export async function getMedianPrice(filters: MarketFilters): Promise<number | null> {
  const filterSql = marketFilterSql(filters);

  const rows = await prisma.$queryRaw<{ median: unknown }[]>`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.price) AS median
    FROM "Product" p
    JOIN "Shop" s ON s.id = p."shopId"
    WHERE s."isActive" = true
      AND p.status = 'ACTIVE'
      AND p.price IS NOT NULL
      ${filterSql}
  `;

  return toNullableNumber(rows[0]?.median ?? null);
}
