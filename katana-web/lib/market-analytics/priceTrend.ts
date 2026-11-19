import { prisma } from "@/lib/prisma";
import { marketFilterSql } from "./filters";
import type { MarketFilters, MarketSnapshot, MarketTrendPoint } from "./types";
import { toNullableNumber } from "./types";

type SnapshotRow = {
  inventoryCount: number;
  disclosedPriceCount: number;
  averagePrice: unknown;
  medianPrice: unknown;
};

/**
 * 任意の過去（または現在の）時点Mにおける市場スナップショットを復元する。
 *
 * - 対象商品: createdAt <= M AND (soldAt IS NULL OR soldAt > M) AND Shop.isActive=true
 *   （soldAt == M の商品は「M時点で既に売約済み」として除外する半開区間）
 * - 価格: Product.priceという「現在値」は使用せず、PriceHistoryのうちchangedAt <= M
 *   を満たす最新レコードのnewPriceのみをM時点の価格として復元する。
 *   M以前のPriceHistoryが1件もない商品（新規登録price=nullのケースを含む）は
 *   価格null扱いとなり、inventoryCountには含めるが価格統計からは除外する。
 *
 * MVP上の既知の制約:
 * - Shop.isActiveは履歴を持たないため、現在のisActive値を過去Snapshotにも適用する
 *   （現在inactiveな店舗の商品は過去Snapshotからも除外される）。
 * - MarketFiltersはProductの現在のmaster FK値に対して適用する
 *   （master属性の変更履歴は保持していないため、過去時点のmaster値は復元しない）。
 */
export async function getMarketSnapshotAt(
  filters: MarketFilters,
  asOf: Date,
): Promise<MarketSnapshot> {
  const filterSql = marketFilterSql(filters);

  const rows = await prisma.$queryRaw<SnapshotRow[]>`
    WITH candidates AS (
      SELECT p.id
      FROM "Product" p
      JOIN "Shop" s ON s.id = p."shopId"
      WHERE s."isActive" = true
        AND p."createdAt" <= ${asOf}
        AND (p."soldAt" IS NULL OR p."soldAt" > ${asOf})
        ${filterSql}
    ),
    resolved AS (
      SELECT c.id, lp."newPrice" AS price
      FROM candidates c
      LEFT JOIN LATERAL (
        SELECT ph."newPrice"
        FROM "PriceHistory" ph
        WHERE ph."productId" = c.id
          AND ph."changedAt" <= ${asOf}
        ORDER BY ph."changedAt" DESC, ph.id DESC
        LIMIT 1
      ) lp ON true
    )
    SELECT
      COUNT(*)::int AS "inventoryCount",
      COUNT(price)::int AS "disclosedPriceCount",
      AVG(price) AS "averagePrice",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS "medianPrice"
    FROM resolved
  `;

  const row = rows[0];
  const disclosedPriceCount = row?.disclosedPriceCount ?? 0;

  return {
    inventoryCount: row?.inventoryCount ?? 0,
    disclosedPriceCount,
    averagePrice: disclosedPriceCount === 0 ? null : toNullableNumber(row.averagePrice),
    medianPrice: disclosedPriceCount === 0 ? null : toNullableNumber(row.medianPrice),
  };
}

/**
 * 複数時点（MVPでは月末日想定）の市場スナップショットをまとめて取得する。
 * 「月末」の算出や「直近Nヶ月」等の方針はBackendでは決めず、呼び出し側が
 * 具体的なDateの配列として渡す（日次・週次もこの引数設計のままBackend変更なしで対応可能）。
 */
export async function getPriceTrend(
  filters: MarketFilters,
  dates: Date[],
): Promise<MarketTrendPoint[]> {
  const snapshots = await Promise.all(dates.map((date) => getMarketSnapshotAt(filters, date)));

  return dates.map((date, index) => ({
    date,
    ...snapshots[index],
  }));
}
