import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PRODUCT_A, PRODUCT_B, SESSION_A, SESSION_B, SHOP_A, SHOP_B } from "@/lib/testing/tenantFixtures";
import ProductTable from "./_components/ProductTable";
import ProductsPage from "./page";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedFindMany = vi.mocked(prisma.product.findMany);

/** 簡易DB: where.shopId に一致する商品だけを返す（条件が無ければ全件＝漏洩を検出できる） */
const ALL_PRODUCTS = [
  { ...PRODUCT_A, title: "アボガド店の刀", price: 1000000, status: "ACTIVE" },
  { ...PRODUCT_B, title: "日光浴の刀", price: 2000000, status: "ACTIVE" },
];

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === type) return node;
  return findElement(node.props.children as ReactNode, type);
}

async function renderedProducts(props?: unknown) {
  const tree = await (ProductsPage as (props?: unknown) => Promise<ReactNode>)(props);
  const table = findElement(tree, ProductTable);
  return table ? (table.props.products as Array<Record<string, unknown>>) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindMany.mockImplementation((async (args: { where?: { shopId?: string } }) =>
    ALL_PRODUCTS.filter((p) => !args?.where?.shopId || p.shopId === args.where.shopId).map(
      ({ id, productCode, title, price, status }) => ({ id, productCode, title, price, status }),
    )) as never);
});

describe("商品一覧ページ: 店舗間の認可", () => {
  it.each([
    ["店舗A", SESSION_A, SHOP_A.id, PRODUCT_A.id, PRODUCT_B.id],
    ["店舗B", SESSION_B, SHOP_B.id, PRODUCT_B.id, PRODUCT_A.id],
  ])("%sでログインすると自店の商品だけが渡り、他店の商品は含まれない", async (_label, session, shopId, ownId, otherId) => {
    mockedAuth.mockResolvedValue(session);

    const products = await renderedProducts();

    expect(mockedFindMany).toHaveBeenCalledTimes(1);
    expect(mockedFindMany.mock.calls[0][0]).toMatchObject({ where: { shopId } });
    expect(products?.map((p) => p.id)).toEqual([ownId]);
    expect(JSON.stringify(products)).not.toContain(otherId);
  });

  it("クライアントへ渡す項目は表示に必要なものだけで、shopIdを含まない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    const products = await renderedProducts();

    expect(Object.keys(products![0]).sort()).toEqual(["id", "price", "productCode", "status", "title"]);
    const select = (mockedFindMany.mock.calls[0][0] as { select: Record<string, boolean> }).select;
    expect(select).not.toHaveProperty("shopId");
  });

  it("URLやpropsでshopIdを指定しても取得対象は変わらない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    const products = await renderedProducts({
      params: Promise.resolve({ locale: "ja" }),
      searchParams: Promise.resolve({ shopId: SHOP_B.id }),
    });

    expect(mockedFindMany.mock.calls[0][0]).toMatchObject({ where: { shopId: SHOP_A.id } });
    expect(products?.map((p) => p.id)).toEqual([PRODUCT_A.id]);
  });

  it("未ログインでは商品を取得せず、一覧を表示しない", async () => {
    mockedAuth.mockResolvedValue(null);

    const products = await renderedProducts();

    expect(mockedFindMany).not.toHaveBeenCalled();
    expect(products).toBeNull();
  });

  it("shopIdを持たないセッションでも商品を取得しない", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "user-without-shop" }, expires: SESSION_A.expires } as never);

    const products = await renderedProducts();

    expect(mockedFindMany).not.toHaveBeenCalled();
    expect(products).toBeNull();
  });
});
