import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupMarketTestFixture,
  createMarketTestFixture,
  createTestProduct,
  type MarketTestFixture,
} from "./testHelpers";
import { getSoldCount } from "./soldMetrics";

describe("getSoldCount (integration, real Postgres)", () => {
  let fixture: MarketTestFixture;
  const productIds: string[] = [];

  async function addProduct(overrides: Parameters<typeof createTestProduct>[1] = {}) {
    const product = await createTestProduct(fixture, overrides);
    productIds.push(product.id);
    return product;
  }

  beforeAll(async () => {
    fixture = await createMarketTestFixture();
  });

  afterAll(async () => {
    await cleanupMarketTestFixture(fixture, productIds);
  });

  const periodStart = new Date("2026-04-01T00:00:00.000Z");
  const periodEnd = new Date("2026-05-01T00:00:00.000Z");

  it("soldAt == periodStart ちょうど → 含む（半開区間の開始境界）", async () => {
    const before = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    await addProduct({ status: "SOLD", soldAt: periodStart, categoryId: fixture.categoryId });
    const after = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    expect(after).toBe(before + 1);
  });

  it("soldAt == periodEnd ちょうど → 含まない（半開区間の終了境界）", async () => {
    const before = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    await addProduct({ status: "SOLD", soldAt: periodEnd, categoryId: fixture.categoryId });
    const after = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    expect(after).toBe(before);
  });

  it("期間外（periodEndより後）→ 含まない", async () => {
    const before = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    await addProduct({
      status: "SOLD",
      soldAt: new Date("2026-06-01T00:00:00.000Z"),
      categoryId: fixture.categoryId,
    });
    const after = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    expect(after).toBe(before);
  });

  it("ACTIVE（soldAt未設定）は含まない", async () => {
    const before = await getSoldCount({ categoryId: fixture.altCategoryId }, periodStart, periodEnd);
    await addProduct({ status: "ACTIVE", categoryId: fixture.altCategoryId });
    const after = await getSoldCount({ categoryId: fixture.altCategoryId }, periodStart, periodEnd);
    expect(after).toBe(before);
  });

  it("inactive Shopの商品は含まない", async () => {
    const before = await getSoldCount({ provinceId: fixture.provinceId }, periodStart, periodEnd);
    await addProduct({
      shopId: fixture.inactiveShopId,
      status: "SOLD",
      soldAt: new Date("2026-04-15T00:00:00.000Z"),
      provinceId: fixture.provinceId,
    });
    const after = await getSoldCount({ provinceId: fixture.provinceId }, periodStart, periodEnd);
    expect(after).toBe(before);
  });

  it("MarketFiltersが適用される（別Categoryは含まれない）", async () => {
    const soldAt = new Date("2026-04-10T00:00:00.000Z");
    const beforeMatching = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    const beforeOther = await getSoldCount({ categoryId: fixture.altCategoryId }, periodStart, periodEnd);

    await addProduct({ status: "SOLD", soldAt, categoryId: fixture.categoryId });

    const afterMatching = await getSoldCount({ categoryId: fixture.categoryId }, periodStart, periodEnd);
    const afterOther = await getSoldCount({ categoryId: fixture.altCategoryId }, periodStart, periodEnd);

    expect(afterMatching).toBe(beforeMatching + 1);
    expect(afterOther).toBe(beforeOther);
  });
});
