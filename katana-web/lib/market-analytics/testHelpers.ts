import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { ProductStatus } from "@prisma/client";

/**
 * Market Analyticsの統合テスト専用fixture。
 * ローカルdocker Postgres（dev DB）に対して実データを作成し、テスト終了後に
 * cleanupMarketTestFixtureで必ず削除する。本体コードからは参照しない。
 */
export type MarketTestFixture = {
  shopId: string;
  inactiveShopId: string;
  categoryId: string;
  altCategoryId: string;
  swordEraId: string;
  gradeId: string;
  rankId: string;
  periodId: string;
  provinceId: string;
  makerId: string;
  appraiserId: string;
};

export async function createMarketTestFixture(): Promise<MarketTestFixture> {
  const suffix = randomUUID();

  const [shop, inactiveShop, category, altCategory, swordEra, grade, rank, period, province, maker, appraiser] =
    await Promise.all([
      prisma.shop.create({ data: { name: `テスト店舗 ${suffix}`, isActive: true } }),
      prisma.shop.create({ data: { name: `テスト休止店舗 ${suffix}`, isActive: false } }),
      prisma.category.create({ data: { name: `テスト刀種 ${suffix}` } }),
      prisma.category.create({ data: { name: `テスト刀種(別) ${suffix}` } }),
      prisma.swordEra.create({ data: { name: `テスト区分 ${suffix}` } }),
      prisma.grade.create({ data: { name: `テスト格付け ${suffix}` } }),
      prisma.rank.create({ data: { name: `テストランク ${suffix}` } }),
      prisma.period.create({ data: { name: `テスト時代 ${suffix}` } }),
      prisma.province.create({ data: { name: `テスト国 ${suffix}` } }),
      prisma.maker.create({ data: { name: `テスト刀匠 ${suffix}` } }),
      prisma.appraiser.create({ data: { name: `テスト鑑定者 ${suffix}` } }),
    ]);

  return {
    shopId: shop.id,
    inactiveShopId: inactiveShop.id,
    categoryId: category.id,
    altCategoryId: altCategory.id,
    swordEraId: swordEra.id,
    gradeId: grade.id,
    rankId: rank.id,
    periodId: period.id,
    provinceId: province.id,
    makerId: maker.id,
    appraiserId: appraiser.id,
  };
}

export async function createTestProduct(
  fixture: MarketTestFixture,
  overrides: Partial<{
    shopId: string;
    status: ProductStatus;
    price: number | null;
    createdAt: Date;
    soldAt: Date | null;
    categoryId: string;
    gradeId: string | null;
    rankId: string | null;
    periodId: string | null;
    provinceId: string | null;
    swordEraId: string;
    makerId: string | null;
    appraiserId: string | null;
  }> = {},
): Promise<{ id: string }> {
  return prisma.product.create({
    data: {
      shopId: overrides.shopId ?? fixture.shopId,
      productCode: `TEST-${randomUUID()}`,
      title: "テスト商品",
      categoryId: overrides.categoryId ?? fixture.categoryId,
      swordEraId: overrides.swordEraId ?? fixture.swordEraId,
      gradeId: overrides.gradeId ?? null,
      rankId: overrides.rankId ?? null,
      periodId: overrides.periodId ?? null,
      provinceId: overrides.provinceId ?? null,
      makerId: overrides.makerId ?? null,
      appraiserId: overrides.appraiserId ?? null,
      price: overrides.price ?? null,
      status: overrides.status ?? "ACTIVE",
      createdAt: overrides.createdAt ?? new Date(),
      soldAt: overrides.soldAt ?? null,
    },
    select: { id: true },
  });
}

export async function createPriceHistory(
  productId: string,
  oldPrice: number | null,
  newPrice: number | null,
  changedAt: Date,
): Promise<void> {
  await prisma.priceHistory.create({
    data: { productId, oldPrice, newPrice, changedAt },
  });
}

export async function cleanupMarketTestFixture(
  fixture: MarketTestFixture,
  productIds: string[],
): Promise<void> {
  await prisma.priceHistory.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.productHistory.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });

  await prisma.shop.deleteMany({ where: { id: { in: [fixture.shopId, fixture.inactiveShopId] } } });
  await prisma.category.deleteMany({ where: { id: { in: [fixture.categoryId, fixture.altCategoryId] } } });
  await prisma.swordEra.deleteMany({ where: { id: fixture.swordEraId } });
  await prisma.grade.deleteMany({ where: { id: fixture.gradeId } });
  await prisma.rank.deleteMany({ where: { id: fixture.rankId } });
  await prisma.period.deleteMany({ where: { id: fixture.periodId } });
  await prisma.province.deleteMany({ where: { id: fixture.provinceId } });
  await prisma.maker.deleteMany({ where: { id: fixture.makerId } });
  await prisma.appraiser.deleteMany({ where: { id: fixture.appraiserId } });
}
