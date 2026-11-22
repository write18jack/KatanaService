import { describe, expect, it } from "vitest";
import {
  cleanupMarketTestFixture,
  createMarketTestFixture,
  createPriceHistory,
  createTestProduct,
  type MarketTestFixture,
} from "./testHelpers";
import { getMarketSnapshotAt, getPriceTrend } from "./priceTrend";

function d(iso: string): Date {
  return new Date(iso);
}

/**
 * 各テストに専用のShop/Masterを作成し、テスト終了後に確実に削除する。
 * 商品の「過去の」永続的な在庫状態（soldAt=null）は他テストの絶対件数アサーションに
 * 干渉しうるため、fixtureをテスト間で共有せず完全に独立させる。
 */
async function withFixture<T>(
  run: (fixture: MarketTestFixture, track: (id: string) => void) => Promise<T>,
): Promise<T> {
  const fixture = await createMarketTestFixture();
  const productIds: string[] = [];
  try {
    return await run(fixture, (id) => productIds.push(id));
  } finally {
    await cleanupMarketTestFixture(fixture, productIds);
  }
}

describe("priceTrend (integration, real Postgres)", () => {
  describe("商品Aの時系列ケース（仕様セクション7）", () => {
    it("月末6時点のスナップショットが期待値と一致する", async () => {
      await withFixture(async (fixture, track) => {
        const product = await createTestProduct(fixture, {
          createdAt: d("2026-04-01T00:00:00.000Z"),
          soldAt: d("2026-09-20T00:00:00.000Z"),
          price: null, // Product.priceの現在値はSnapshot計算に使用しない
        });
        track(product.id);

        await createPriceHistory(product.id, null, 1500000, d("2026-04-01T00:00:00.000Z"));
        await createPriceHistory(product.id, 1500000, 1300000, d("2026-05-10T00:00:00.000Z"));
        await createPriceHistory(product.id, 1300000, null, d("2026-06-15T00:00:00.000Z"));
        await createPriceHistory(product.id, null, 1200000, d("2026-08-05T00:00:00.000Z"));

        const monthEndDates = [
          d("2026-04-30T23:59:59.999Z"),
          d("2026-05-31T23:59:59.999Z"),
          d("2026-06-30T23:59:59.999Z"),
          d("2026-07-31T23:59:59.999Z"),
          d("2026-08-31T23:59:59.999Z"),
          d("2026-09-30T23:59:59.999Z"),
        ];

        const trend = await getPriceTrend({ categoryId: fixture.categoryId }, monthEndDates);

        expect(trend).toHaveLength(6);

        // 2026-04-30: ACTIVE, price=1500000, 在庫に含む, 価格統計に含む
        expect(trend[0]).toMatchObject({
          inventoryCount: 1,
          disclosedPriceCount: 1,
          averagePrice: 1500000,
          medianPrice: 1500000,
        });

        // 2026-05-31: ACTIVE, price=1300000
        expect(trend[1]).toMatchObject({
          inventoryCount: 1,
          disclosedPriceCount: 1,
          averagePrice: 1300000,
          medianPrice: 1300000,
        });

        // 2026-06-30: ACTIVE, price=null → 在庫に含むが価格統計から除外
        expect(trend[2]).toMatchObject({
          inventoryCount: 1,
          disclosedPriceCount: 0,
          averagePrice: null,
          medianPrice: null,
        });

        // 2026-07-31: ACTIVE, price=null（変わらず）
        expect(trend[3]).toMatchObject({
          inventoryCount: 1,
          disclosedPriceCount: 0,
          averagePrice: null,
          medianPrice: null,
        });

        // 2026-08-31: ACTIVE, price=1200000
        expect(trend[4]).toMatchObject({
          inventoryCount: 1,
          disclosedPriceCount: 1,
          averagePrice: 1200000,
          medianPrice: 1200000,
        });

        // 2026-09-30: すでにSOLD（soldAt=2026-09-20 <= M）→ 在庫・価格統計から完全除外
        expect(trend[5]).toMatchObject({
          inventoryCount: 0,
          disclosedPriceCount: 0,
          averagePrice: null,
          medianPrice: null,
        });

        // getPriceTrendは渡したdateをそのまま返す
        trend.forEach((point, i) => expect(point.date).toBe(monthEndDates[i]));
      });
    });
  });

  describe("単発ケース（仕様セクション8・9・15）", () => {
    it("新規登録price=null・PriceHistoryなし → inventoryには含むが価格統計から除外", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-02-01T00:00:00.000Z");
        const product = await createTestProduct(fixture, {
          createdAt: d("2026-01-01T00:00:00.000Z"),
          price: null,
        });
        track(product.id);

        const snapshot = await getMarketSnapshotAt({ categoryId: fixture.categoryId }, asOf);
        expect(snapshot.inventoryCount).toBe(1);
        expect(snapshot.disclosedPriceCount).toBe(0);
        expect(snapshot.averagePrice).toBeNull();
        expect(snapshot.medianPrice).toBeNull();
      });
    });

    it("null → price（PriceHistoryで価格が付いた直後）", async () => {
      await withFixture(async (fixture, track) => {
        const product = await createTestProduct(fixture, { createdAt: d("2026-01-01T00:00:00.000Z") });
        track(product.id);
        await createPriceHistory(product.id, null, 500000, d("2026-01-10T00:00:00.000Z"));

        const snapshot = await getMarketSnapshotAt(
          { categoryId: fixture.categoryId },
          d("2026-01-15T00:00:00.000Z"),
        );
        expect(snapshot.inventoryCount).toBe(1);
        expect(snapshot.disclosedPriceCount).toBe(1);
        expect(snapshot.averagePrice).toBe(500000);
        expect(snapshot.medianPrice).toBe(500000);
      });
    });

    it("price → null（応相談化）", async () => {
      await withFixture(async (fixture, track) => {
        const product = await createTestProduct(fixture, { createdAt: d("2026-01-01T00:00:00.000Z") });
        track(product.id);
        await createPriceHistory(product.id, null, 500000, d("2026-01-05T00:00:00.000Z"));
        await createPriceHistory(product.id, 500000, null, d("2026-01-10T00:00:00.000Z"));

        const snapshot = await getMarketSnapshotAt(
          { categoryId: fixture.categoryId },
          d("2026-01-15T00:00:00.000Z"),
        );
        expect(snapshot.inventoryCount).toBe(1);
        expect(snapshot.disclosedPriceCount).toBe(0);
        expect(snapshot.averagePrice).toBeNull();
        expect(snapshot.medianPrice).toBeNull();
      });
    });

    it("price A → price B（最新の変更が優先される）", async () => {
      await withFixture(async (fixture, track) => {
        const product = await createTestProduct(fixture, { createdAt: d("2026-01-01T00:00:00.000Z") });
        track(product.id);
        await createPriceHistory(product.id, null, 100000, d("2026-01-05T00:00:00.000Z"));
        await createPriceHistory(product.id, 100000, 200000, d("2026-01-10T00:00:00.000Z"));

        const snapshot = await getMarketSnapshotAt(
          { categoryId: fixture.categoryId },
          d("2026-01-15T00:00:00.000Z"),
        );
        expect(snapshot.disclosedPriceCount).toBe(1);
        expect(snapshot.averagePrice).toBe(200000);
        expect(snapshot.medianPrice).toBe(200000);
      });
    });

    it("createdAt == M → 含む", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-03-01T00:00:00.000Z");
        const product = await createTestProduct(fixture, { createdAt: asOf });
        track(product.id);

        const snapshot = await getMarketSnapshotAt({ categoryId: fixture.categoryId }, asOf);
        expect(snapshot.inventoryCount).toBe(1);
      });
    });

    it("createdAt > M → 含まない", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-03-01T00:00:00.000Z");
        const product = await createTestProduct(fixture, { createdAt: d("2026-03-02T00:00:00.000Z") });
        track(product.id);

        const snapshot = await getMarketSnapshotAt({ categoryId: fixture.categoryId }, asOf);
        expect(snapshot.inventoryCount).toBe(0);
      });
    });

    it("soldAt == M → 含まない（半開区間）", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-03-10T00:00:00.000Z");
        const product = await createTestProduct(fixture, {
          createdAt: d("2026-01-01T00:00:00.000Z"),
          soldAt: asOf,
        });
        track(product.id);

        const snapshot = await getMarketSnapshotAt({ categoryId: fixture.categoryId }, asOf);
        expect(snapshot.inventoryCount).toBe(0);
      });
    });

    it("soldAt > M → 含む", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-03-10T00:00:00.000Z");
        const product = await createTestProduct(fixture, {
          createdAt: d("2026-01-01T00:00:00.000Z"),
          soldAt: d("2026-03-11T00:00:00.000Z"),
        });
        track(product.id);

        const snapshot = await getMarketSnapshotAt({ categoryId: fixture.categoryId }, asOf);
        expect(snapshot.inventoryCount).toBe(1);
      });
    });

    it("never sold（soldAt=null）は十分未来の時点でも含む", async () => {
      await withFixture(async (fixture, track) => {
        const product = await createTestProduct(fixture, {
          createdAt: d("2020-01-01T00:00:00.000Z"),
          soldAt: null,
        });
        track(product.id);

        const snapshot = await getMarketSnapshotAt(
          { categoryId: fixture.categoryId },
          d("2030-01-01T00:00:00.000Z"),
        );
        expect(snapshot.inventoryCount).toBe(1);
      });
    });

    it("inactive Shopの商品は過去Snapshotからも除外される", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-01-15T00:00:00.000Z");
        const product = await createTestProduct(fixture, {
          shopId: fixture.inactiveShopId,
          createdAt: d("2026-01-01T00:00:00.000Z"),
        });
        track(product.id);

        const snapshot = await getMarketSnapshotAt({ categoryId: fixture.categoryId }, asOf);
        expect(snapshot.inventoryCount).toBe(0);
      });
    });

    it("MarketFiltersが過去Snapshotにも適用される（現在のmaster FK値を使用）", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-01-20T00:00:00.000Z");
        const matching = await createTestProduct(fixture, {
          createdAt: d("2026-01-01T00:00:00.000Z"),
          makerId: fixture.makerId,
        });
        const nonMatching = await createTestProduct(fixture, {
          createdAt: d("2026-01-01T00:00:00.000Z"),
          // makerId未指定 = フィルタに一致しない
        });
        track(matching.id);
        track(nonMatching.id);

        const snapshot = await getMarketSnapshotAt(
          { categoryId: fixture.categoryId, makerId: fixture.makerId },
          asOf,
        );
        expect(snapshot.inventoryCount).toBe(1);
      });
    });

    it("価格公開商品0件 → averagePrice/medianPrice=null", async () => {
      await withFixture(async (fixture) => {
        const snapshot = await getMarketSnapshotAt(
          { categoryId: fixture.categoryId },
          d("2026-01-01T00:00:00.000Z"),
        );
        expect(snapshot.inventoryCount).toBe(0);
        expect(snapshot.disclosedPriceCount).toBe(0);
        expect(snapshot.averagePrice).toBeNull();
        expect(snapshot.medianPrice).toBeNull();
      });
    });

    it("複数商品でaverage/medianが正しく計算される", async () => {
      await withFixture(async (fixture, track) => {
        const asOf = d("2026-01-15T00:00:00.000Z");

        for (const price of [100, 200, 300]) {
          const product = await createTestProduct(fixture, { createdAt: d("2026-01-01T00:00:00.000Z") });
          track(product.id);
          await createPriceHistory(product.id, null, price, d("2026-01-02T00:00:00.000Z"));
        }

        const snapshot = await getMarketSnapshotAt({ categoryId: fixture.categoryId }, asOf);
        expect(snapshot.inventoryCount).toBe(3);
        expect(snapshot.disclosedPriceCount).toBe(3);
        expect(snapshot.averagePrice).toBe(200);
        expect(snapshot.medianPrice).toBe(200);
      });
    });
  });
});
