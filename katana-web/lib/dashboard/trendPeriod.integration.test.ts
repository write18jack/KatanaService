import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getPriceTrend } from "@/lib/market-analytics/priceTrend";
import {
  cleanupMarketTestFixture,
  createMarketTestFixture,
  createPriceHistory,
  createTestProduct,
  type MarketTestFixture,
} from "@/lib/market-analytics/testHelpers";
import { getLastCompletedMonthEnds } from "./trendPeriod";

/**
 * JST月末Snapshot境界の統合テスト（ローカルdocker Postgres）。
 * getLastCompletedMonthEndsが返すasOf（月末23:59:59.999 JST）を、変更していない
 * Phase 2のgetPriceTrend（実SQL）へそのまま渡し、「翌月1日00:00 JSTをexclusive upper bound
 * とするSnapshot」と同じ結果になることを確認する。
 * 各ケースは専用Categoryで分離し、作成データはafterAllで削除する。
 */
describe("JST月末Snapshot境界 (integration, real Postgres)", () => {
  const monthEnds = getLastCompletedMonthEnds(new Date("2026-10-10T03:00:00Z"));
  const dates = monthEnds.map((m) => m.asOf);
  const AUG = 10;
  const SEP = 11;

  /** 2026-09-30 23:59:59.999 JST */
  const septemberEnd = new Date("2026-09-30T14:59:59.999Z");
  /** 2026-10-01 00:00:00.000 JST */
  const octoberStart = new Date("2026-09-30T15:00:00.000Z");
  const july = new Date("2026-07-15T03:00:00Z");

  let fixture: MarketTestFixture;
  const productIds: string[] = [];
  const categoryIds: string[] = [];

  async function isolatedCategory(): Promise<string> {
    const category = await prisma.category.create({ data: { name: `テスト境界 ${randomUUID()}` } });
    categoryIds.push(category.id);
    return category.id;
  }

  async function addProduct(overrides: Parameters<typeof createTestProduct>[1]) {
    const product = await createTestProduct(fixture, overrides);
    productIds.push(product.id);
    return product;
  }

  beforeAll(async () => {
    fixture = await createMarketTestFixture();
  });

  afterAll(async () => {
    await cleanupMarketTestFixture(fixture, productIds);
    await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
  });

  it("前提: 9月のSnapshot時点は月末23:59:59.999 JSTで、12点を渡す", () => {
    expect(dates).toHaveLength(12);
    expect(dates[SEP].getTime()).toBe(septemberEnd.getTime());
    expect(octoberStart.getTime() - dates[SEP].getTime()).toBe(1);
  });

  it("月末ちょうどのPriceHistory → 9月末の価格に反映される", async () => {
    const categoryId = await isolatedCategory();
    const product = await addProduct({ categoryId, createdAt: july });
    await createPriceHistory(product.id, null, 500_000, july);
    await createPriceHistory(product.id, 500_000, 1_000_000, septemberEnd);

    const trend = await getPriceTrend({ categoryId }, dates);

    expect(trend[AUG].averagePrice).toBe(500_000);
    expect(trend[SEP].averagePrice).toBe(1_000_000);
    expect(trend[SEP].medianPrice).toBe(1_000_000);
  });

  it("翌月1日00:00 JSTのPriceHistory → 9月末には反映されない", async () => {
    const categoryId = await isolatedCategory();
    const product = await addProduct({ categoryId, createdAt: july });
    await createPriceHistory(product.id, null, 500_000, july);
    await createPriceHistory(product.id, 500_000, 2_000_000, octoberStart);

    const trend = await getPriceTrend({ categoryId }, dates);

    expect(trend[SEP].averagePrice).toBe(500_000);
    expect(trend[SEP].disclosedPriceCount).toBe(1);
  });

  it("月末ちょうどのcreatedAt → 9月末の在庫に含む（8月末には含まない）", async () => {
    const categoryId = await isolatedCategory();
    await addProduct({ categoryId, createdAt: septemberEnd });

    const trend = await getPriceTrend({ categoryId }, dates);

    expect(trend[AUG].inventoryCount).toBe(0);
    expect(trend[SEP].inventoryCount).toBe(1);
  });

  it("月初ちょうど（翌月1日00:00 JST）のcreatedAt → 9月末の在庫に含まない", async () => {
    const categoryId = await isolatedCategory();
    await addProduct({ categoryId, createdAt: octoberStart });

    const trend = await getPriceTrend({ categoryId }, dates);

    expect(trend[SEP].inventoryCount).toBe(0);
  });

  it("月末ちょうどのsoldAt → 9月中に売約済みとして9月末の在庫に含まない（8月末には含む）", async () => {
    const categoryId = await isolatedCategory();
    await addProduct({ categoryId, createdAt: july, status: "SOLD", soldAt: septemberEnd });

    const trend = await getPriceTrend({ categoryId }, dates);

    expect(trend[AUG].inventoryCount).toBe(1);
    expect(trend[SEP].inventoryCount).toBe(0);
  });

  it("月初ちょうど（翌月1日00:00 JST）のsoldAt → 9月末時点ではまだ在庫に含む", async () => {
    const categoryId = await isolatedCategory();
    const product = await addProduct({ categoryId, createdAt: july, status: "SOLD", soldAt: octoberStart });
    await createPriceHistory(product.id, null, 800_000, july);

    const trend = await getPriceTrend({ categoryId }, dates);

    expect(trend[SEP].inventoryCount).toBe(1);
    expect(trend[SEP].averagePrice).toBe(800_000);
  });

  it("価格公開0件の月はnull（0ではない）で、在庫数は保持される", async () => {
    const categoryId = await isolatedCategory();
    await addProduct({ categoryId, createdAt: july });

    const trend = await getPriceTrend({ categoryId }, dates);

    expect(trend[SEP].inventoryCount).toBe(1);
    expect(trend[SEP].disclosedPriceCount).toBe(0);
    expect(trend[SEP].averagePrice).toBeNull();
    expect(trend[SEP].medianPrice).toBeNull();
  });
});
