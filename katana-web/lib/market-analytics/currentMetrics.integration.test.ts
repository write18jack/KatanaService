import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupMarketTestFixture,
  createMarketTestFixture,
  createTestProduct,
  type MarketTestFixture,
} from "./testHelpers";
import { getAveragePrice, getMarketInventoryCount, getMedianPrice } from "./currentMetrics";

describe("currentMetrics (integration, real Postgres)", () => {
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

  describe("getMarketInventoryCount", () => {
    it("ACTIVE + active Shopの商品を含む", async () => {
      await addProduct({ status: "ACTIVE" });
      const before = await getMarketInventoryCount({ categoryId: fixture.categoryId });
      expect(before).toBeGreaterThanOrEqual(1);
    });

    it("SOLDの商品は含まない", async () => {
      const base = await getMarketInventoryCount({ categoryId: fixture.altCategoryId });
      await addProduct({ status: "SOLD", soldAt: new Date(), categoryId: fixture.altCategoryId });
      const after = await getMarketInventoryCount({ categoryId: fixture.altCategoryId });
      expect(after).toBe(base);
    });

    it("inactive Shopの商品は含まない", async () => {
      const before = await getMarketInventoryCount({ provinceId: fixture.provinceId });
      await addProduct({ shopId: fixture.inactiveShopId, provinceId: fixture.provinceId });
      const after = await getMarketInventoryCount({ provinceId: fixture.provinceId });
      expect(after).toBe(before);
    });

    it("price=nullのACTIVE商品も含む", async () => {
      const before = await getMarketInventoryCount({ rankId: fixture.rankId });
      await addProduct({ status: "ACTIVE", price: null, rankId: fixture.rankId });
      const after = await getMarketInventoryCount({ rankId: fixture.rankId });
      expect(after).toBe(before + 1);
    });

    it("MarketFiltersが適用される（別categoryは含まれない）", async () => {
      const uniqueCategoryCount = await getMarketInventoryCount({ categoryId: fixture.categoryId });
      const products = await Promise.all([
        addProduct({ categoryId: fixture.categoryId }),
        addProduct({ categoryId: fixture.altCategoryId }),
      ]);
      void products;
      const after = await getMarketInventoryCount({ categoryId: fixture.categoryId });
      expect(after).toBe(uniqueCategoryCount + 1);
    });
  });

  describe("getAveragePrice", () => {
    it("ACTIVE + priceありは含む、price=nullは除外、SOLD/inactive Shopも除外される", async () => {
      const periodKey = fixture.gradeId;
      await Promise.all([
        addProduct({ status: "ACTIVE", price: 100, gradeId: periodKey }),
        addProduct({ status: "ACTIVE", price: 200, gradeId: periodKey }),
        addProduct({ status: "ACTIVE", price: null, gradeId: periodKey }),
        addProduct({ status: "SOLD", soldAt: new Date(), price: 999999, gradeId: periodKey }),
        addProduct({ shopId: fixture.inactiveShopId, price: 999999, gradeId: periodKey }),
      ]);

      const result = await getAveragePrice({ gradeId: periodKey });

      expect(result.disclosedPriceCount).toBe(2);
      expect(result.averagePrice).toBe(150);
      expect(result.totalInventoryCount).toBe(3); // ACTIVE 3件（price null含む）、SOLD/inactiveは除外
    });

    it("価格公開商品が0件の場合averagePrice=null", async () => {
      await addProduct({ status: "ACTIVE", price: null, periodId: fixture.periodId });
      const result = await getAveragePrice({ periodId: fixture.periodId });

      expect(result.disclosedPriceCount).toBe(0);
      expect(result.averagePrice).toBeNull();
      expect(result.totalInventoryCount).toBe(1);
    });
  });

  describe("getMedianPrice", () => {
    it("奇数件の中央値", async () => {
      const key = fixture.makerId;
      await Promise.all([
        addProduct({ price: 100, makerId: key }),
        addProduct({ price: 200, makerId: key }),
        addProduct({ price: 300, makerId: key }),
      ]);
      expect(await getMedianPrice({ makerId: key })).toBe(200);
    });

    it("偶数件の中央値（PERCENTILE_CONTの補間）", async () => {
      const key = fixture.appraiserId;
      await Promise.all([
        addProduct({ price: 100, appraiserId: key }),
        addProduct({ price: 200, appraiserId: key }),
      ]);
      expect(await getMedianPrice({ appraiserId: key })).toBe(150);
    });

    it("1件の場合はその価格そのもの", async () => {
      // altCategoryIdの既存商品はSOLDまたはprice=nullのため、ここで追加する
      // price=777の1件のみが中央値計算の母集団になる。
      await addProduct({ price: 777, categoryId: fixture.altCategoryId });
      const median = await getMedianPrice({ categoryId: fixture.altCategoryId });
      expect(median).toBe(777);
    });

    it("0件の場合medianPrice=null", async () => {
      const isolated = await createMarketTestFixture();
      const median = await getMedianPrice({ categoryId: isolated.categoryId });
      expect(median).toBeNull();
      await cleanupMarketTestFixture(isolated, []);
    });

    it("price=null / SOLD / inactive Shopは中央値計算から除外される", async () => {
      const key = fixture.rankId;
      const before = await getMedianPrice({ rankId: key });
      await Promise.all([
        addProduct({ price: null, rankId: key }),
        addProduct({ status: "SOLD", soldAt: new Date(), price: 123456789, rankId: key }),
        addProduct({ shopId: fixture.inactiveShopId, price: 123456789, rankId: key }),
      ]);
      const after = await getMedianPrice({ rankId: key });
      expect(after).toBe(before);
    });

    it("MarketFiltersが適用される（別provinceの商品は中央値に含まれない）", async () => {
      await addProduct({ price: 500, provinceId: fixture.provinceId });
      await addProduct({ price: 999999 }); // provinceId未指定 = フィルタに一致しない
      const median = await getMedianPrice({ provinceId: fixture.provinceId });
      expect(median).toBe(500);
    });
  });
});
