import { prisma } from "@/lib/prisma";
import type { MarketFilterMasterOptions } from "./marketFilters";

/**
 * Prismaを使う部分だけをmarketFilters.tsから分離したファイル。
 * MarketFilterBar（Client Component）がmarketFilters.tsの純粋関数・定数を
 * importしてもPrisma（pg driver）がクライアントバンドルへ混入しないようにするため。
 */

const MASTER_SELECT = { id: true, name: true } as const;
const MASTER_ORDER_BY = [{ displayOrder: "asc" as const }, { name: "asc" as const }];

/**
 * 8種類のMasterをisActive=trueのみ、displayOrder→name順で並列取得する。
 * フィルター選択肢と、URLパラメータ検証用の「有効なID集合」の両方に使う。
 */
export async function getMarketFilterMasters(): Promise<MarketFilterMasterOptions> {
  const [category, grade, rank, period, province, swordEra, maker, appraiser] = await Promise.all([
    prisma.category.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
    prisma.grade.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
    prisma.rank.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
    prisma.period.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
    prisma.province.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
    prisma.swordEra.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
    prisma.maker.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
    prisma.appraiser.findMany({ where: { isActive: true }, orderBy: MASTER_ORDER_BY, select: MASTER_SELECT }),
  ]);

  return {
    categoryId: category,
    gradeId: grade,
    rankId: rank,
    periodId: period,
    provinceId: province,
    swordEraId: swordEra,
    makerId: maker,
    appraiserId: appraiser,
  };
}
