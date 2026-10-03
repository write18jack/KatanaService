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
    $transaction: vi.fn(),
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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
