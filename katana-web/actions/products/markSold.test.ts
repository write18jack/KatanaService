import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    productHistory: {
      create: vi.fn(),
    },
    priceHistory: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { MISSING_ID, PRODUCT_A, PRODUCT_B, SESSION_A, SESSION_B, SHOP_A, SHOP_B, USER_A } from "@/lib/testing/tenantFixtures";
import { markProductAsSold } from "./markSold";

type AuthMock = (...args: never[]) => Promise<unknown>;

const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedFindUnique = vi.mocked(prisma.product.findUnique);
const mockedTransaction = vi.mocked(prisma.$transaction);

const SESSION = {
  user: { id: "user-1", shopId: "shop-1", role: "STORE" },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("markProductAsSold", () => {
  it("未認証の場合はエラーを返す", async () => {
    mockedAuth.mockResolvedValue(null);

    const result = await markProductAsSold("product-1");

    expect(result.error).toBeDefined();
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("他店舗の商品は操作できない", async () => {
    mockedAuth.mockResolvedValue(SESSION);
    mockedFindUnique.mockResolvedValue({
      id: "product-1",
      shopId: "other-shop",
      status: "ACTIVE",
    } as never);

    const result = await markProductAsSold("product-1");

    expect(result.error).toBeDefined();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("すでにSOLDの商品は再度SOLDにできない", async () => {
    mockedAuth.mockResolvedValue(SESSION);
    mockedFindUnique.mockResolvedValue({
      id: "product-1",
      shopId: "shop-1",
      status: "SOLD",
    } as never);

    const result = await markProductAsSold("product-1");

    expect(result.error).toBeDefined();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("自店舗のACTIVE商品はSOLDへ遷移できる", async () => {
    mockedAuth.mockResolvedValue(SESSION);
    mockedFindUnique.mockResolvedValue({
      id: "product-1",
      shopId: "shop-1",
      status: "ACTIVE",
    } as never);
    mockedTransaction.mockResolvedValue([{}, {}] as never);

    const result = await markProductAsSold("product-1");

    expect(result.success).toBeDefined();
    expect(mockedTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("markProductAsSold: 店舗間の認可（双方向）", () => {
  const mockedUpdate = vi.mocked(prisma.product.update);
  const mockedHistoryCreate = vi.mocked(prisma.productHistory.create);
  const mockedPriceHistoryCreate = vi.mocked(prisma.priceHistory.create);

  function productRecord(product: typeof PRODUCT_A | typeof PRODUCT_B, status: "ACTIVE" | "SOLD" = "ACTIVE") {
    return { id: product.id, shopId: product.shopId, productCode: product.productCode, status } as never;
  }

  function expectNoWrites() {
    expect(mockedTransaction).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedHistoryCreate).not.toHaveBeenCalled();
    expect(mockedPriceHistoryCreate).not.toHaveBeenCalled();
  }

  it("ケースA: 店舗Aのユーザーは店舗Aの商品をSOLDにでき、更新・履歴は店舗Aの商品だけに作られる", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(productRecord(PRODUCT_A));
    mockedTransaction.mockResolvedValue([{}, {}] as never);

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result.success).toBeDefined();
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { id: PRODUCT_A.id } });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: PRODUCT_A.id },
      data: { status: "SOLD", updatedById: USER_A.id },
    });
    expect(mockedHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mockedHistoryCreate.mock.calls[0][0]).toMatchObject({
      data: {
        productId: PRODUCT_A.id,
        action: "STATUS_CHANGE",
        changedById: USER_A.id,
        oldValue: { status: "ACTIVE" },
        newValue: { status: "SOLD" },
      },
    });
    // SOLD変更は価格を変えないため価格履歴は作らない
    expect(mockedPriceHistoryCreate).not.toHaveBeenCalled();
  });

  it("ケースB: 店舗Aのユーザーが店舗Bの商品IDを指定すると拒否され、副作用がない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(productRecord(PRODUCT_B));

    const result = await markProductAsSold(PRODUCT_B.id);

    expect(result.success).toBeUndefined();
    expect(result.error).toBeDefined();
    expectNoWrites();
  });

  it("ケースC: 店舗Bのユーザーが店舗Aの商品IDを指定すると拒否され、副作用がない", async () => {
    mockedAuth.mockResolvedValue(SESSION_B);
    mockedFindUnique.mockResolvedValue(productRecord(PRODUCT_A));

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result.success).toBeUndefined();
    expect(result.error).toBeDefined();
    expectNoWrites();
  });

  it("ケースD: 未ログインでは商品を検索せず拒否され、副作用がない", async () => {
    mockedAuth.mockResolvedValue(null);

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result.error).toBeDefined();
    expect(mockedFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("ケースD': shopIdを持たないセッションも拒否される", async () => {
    mockedAuth.mockResolvedValue({ user: { id: USER_A.id }, expires: SESSION_A.expires } as never);

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result.error).toBeDefined();
    expect(mockedFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("ケースE: 存在しない商品IDは拒否され、副作用がない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(null);

    const result = await markProductAsSold(MISSING_ID);

    expect(result.error).toBeDefined();
    expectNoWrites();
  });

  it("他店舗の商品と存在しない商品で応答が同一（存在を推測できない）", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValueOnce(productRecord(PRODUCT_B));
    const otherShop = await markProductAsSold(PRODUCT_B.id);

    mockedFindUnique.mockResolvedValueOnce(null);
    const missing = await markProductAsSold(MISSING_ID);

    expect(otherShop).toEqual(missing);
  });

  it("ケースF: すでにSOLDの自店商品は更新も履歴追加もされない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(productRecord(PRODUCT_A, "SOLD"));

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result.error).toBeDefined();
    expectNoWrites();
  });

  it("店舗Bでも同じ規則: 自店の商品だけ更新され、店舗Aの商品には触れない", async () => {
    mockedAuth.mockResolvedValue(SESSION_B);
    mockedFindUnique.mockResolvedValue(productRecord(PRODUCT_B));
    mockedTransaction.mockResolvedValue([{}, {}] as never);

    const result = await markProductAsSold(PRODUCT_B.id);

    expect(result.success).toBeDefined();
    expect(mockedUpdate.mock.calls[0][0]).toMatchObject({ where: { id: PRODUCT_B.id } });
    expect(mockedHistoryCreate.mock.calls[0][0]).toMatchObject({ data: { productId: PRODUCT_B.id } });
    const touchedIds = [...mockedUpdate.mock.calls, ...mockedHistoryCreate.mock.calls].map((call) => JSON.stringify(call));
    expect(touchedIds.some((call) => call.includes(PRODUCT_A.id) || call.includes(SHOP_A.id))).toBe(false);
    expect(SHOP_B.id).toBe(PRODUCT_B.shopId);
  });
});
