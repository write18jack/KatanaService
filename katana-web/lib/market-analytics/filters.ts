import { Prisma } from "@prisma/client";
import type { MarketFilters } from "./types";

/**
 * Prismaのquery builder（count/aggregate）で使うwhere断片を組み立てる。
 * 指定されたfilterのみAND条件として適用し、未指定のfilterは無視する。
 */
export function marketFilterWhere(filters: MarketFilters): Prisma.ProductWhereInput {
  return {
    ...(filters.categoryId && { categoryId: filters.categoryId }),
    ...(filters.gradeId && { gradeId: filters.gradeId }),
    ...(filters.rankId && { rankId: filters.rankId }),
    ...(filters.periodId && { periodId: filters.periodId }),
    ...(filters.provinceId && { provinceId: filters.provinceId }),
    ...(filters.swordEraId && { swordEraId: filters.swordEraId }),
    ...(filters.makerId && { makerId: filters.makerId }),
    ...(filters.appraiserId && { appraiserId: filters.appraiserId }),
  };
}

/**
 * raw SQL（$queryRaw）に埋め込むfilter断片を組み立てる。
 * marketFilterWhereと同一semantics（未指定は無視・複数指定はAND）。
 * 値はPrisma.sqlのテンプレート補間により必ずparameterized bindとなり、
 * 文字列連結は行わない。呼び出し側のSQLでは別名 "p" のProductを前提とする。
 */
export function marketFilterSql(filters: MarketFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  if (filters.categoryId) conditions.push(Prisma.sql`p."categoryId" = ${filters.categoryId}`);
  if (filters.gradeId) conditions.push(Prisma.sql`p."gradeId" = ${filters.gradeId}`);
  if (filters.rankId) conditions.push(Prisma.sql`p."rankId" = ${filters.rankId}`);
  if (filters.periodId) conditions.push(Prisma.sql`p."periodId" = ${filters.periodId}`);
  if (filters.provinceId) conditions.push(Prisma.sql`p."provinceId" = ${filters.provinceId}`);
  if (filters.swordEraId) conditions.push(Prisma.sql`p."swordEraId" = ${filters.swordEraId}`);
  if (filters.makerId) conditions.push(Prisma.sql`p."makerId" = ${filters.makerId}`);
  if (filters.appraiserId) conditions.push(Prisma.sql`p."appraiserId" = ${filters.appraiserId}`);

  if (conditions.length === 0) return Prisma.sql``;

  return Prisma.join(conditions, " AND ", "AND ");
}
