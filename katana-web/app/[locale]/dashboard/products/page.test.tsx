import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => {
  /** redirect() は例外で処理を打ち切る。テストでは遷移先を持つ例外として観測する */
  class RedirectSignal extends Error {
    constructor(
      readonly href: string,
      readonly locale: string,
    ) {
      super(`NEXT_REDIRECT:/${locale}${href}`);
    }
  }
  return { RedirectSignal };
});

vi.mock("next-intl/server", () => ({
  getLocale: async () => "ja",
}));

vi.mock("@/i18n/navigation", () => ({
  redirect: vi.fn(({ href, locale }: { href: string; locale: string }) => {
    throw new nav.RedirectSignal(href, locale);
  }),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// 認可はDB由来のコンテキストで行う。多くのテストは結果をモックし、一部は実際のヘルパーを通す
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getAuthContext: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { redirect } from "@/i18n/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { prisma } from "@/lib/prisma";
import { PRODUCT_A, PRODUCT_B, SESSION_A, SESSION_B, SHOP_A, SHOP_B, USER_A } from "@/lib/testing/tenantFixtures";
import ProductTable from "./_components/ProductTable";
import ProductsPage from "./page";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedFindMany = vi.mocked(prisma.product.findMany);
const mockedAuthContext = vi.mocked(getAuthContext);
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique);
const actualAuthContext = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");

type SessionLike = { user: { id: string; shopId: string; role: string } };

/** DB照合に成功した認可コンテキスト（DB上の値がセッションと一致している場合） */
function signInAs(session: SessionLike) {
  mockedAuthContext.mockResolvedValue({
    ok: true,
    context: { userId: session.user.id, shopId: session.user.shopId, role: session.user.role as UserRole },
  });
}

function denyAuth(reason: "UNAUTHENTICATED" | "USER_NOT_FOUND" | "SHOP_INACTIVE") {
  mockedAuthContext.mockResolvedValue({ ok: false, reason });
}

/** 実際の認可ヘルパーを通す（auth() が返すJWTと、DB上のUserだけをモックする） */
function useRealAuthContext(jwt: unknown, dbUser: unknown) {
  mockedAuthContext.mockImplementation(actualAuthContext.getAuthContext);
  mockedAuth.mockResolvedValue(jwt);
  mockedUserFindUnique.mockResolvedValue(dbUser as never);
}

/** ページが redirect() した遷移先（/{locale}{href}） */
async function redirectTarget(render: Promise<unknown>) {
  const error = await render.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(nav.RedirectSignal);
  const signal = error as InstanceType<typeof nav.RedirectSignal>;
  return `/${signal.locale}${signal.href}`;
}

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
  mockedAuth.mockReset();
  mockedAuthContext.mockReset();
  mockedUserFindUnique.mockReset();
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
    signInAs(session);

    const products = await renderedProducts();

    expect(mockedFindMany).toHaveBeenCalledTimes(1);
    expect(mockedFindMany.mock.calls[0][0]).toMatchObject({ where: { shopId } });
    expect(products?.map((p) => p.id)).toEqual([ownId]);
    expect(JSON.stringify(products)).not.toContain(otherId);
  });

  it("クライアントへ渡す項目は表示に必要なものだけで、shopIdを含まない", async () => {
    signInAs(SESSION_A);

    const products = await renderedProducts();

    expect(Object.keys(products![0]).sort()).toEqual(["id", "price", "productCode", "status", "title"]);
    const select = (mockedFindMany.mock.calls[0][0] as { select: Record<string, boolean> }).select;
    expect(select).not.toHaveProperty("shopId");
  });

  it("URLやpropsでshopIdを指定しても取得対象は変わらない", async () => {
    signInAs(SESSION_A);

    const products = await renderedProducts({
      params: Promise.resolve({ locale: "ja" }),
      searchParams: Promise.resolve({ shopId: SHOP_B.id }),
    });

    expect(mockedFindMany.mock.calls[0][0]).toMatchObject({ where: { shopId: SHOP_A.id } });
    expect(products?.map((p) => p.id)).toEqual([PRODUCT_A.id]);
  });

  it("未ログインでは商品を取得せず、一覧を表示せずにログイン画面へ遷移する", async () => {
    denyAuth("UNAUTHENTICATED");

    await expect(redirectTarget(renderedProducts())).resolves.toBe("/ja/login");

    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it.each([
    ["無効店舗", "SHOP_INACTIVE"],
    ["削除済みユーザー", "USER_NOT_FOUND"],
  ] as const)("%sは商品を取得せず、一覧を表示せずにアクセス停止画面へ遷移する", async (_label, reason) => {
    denyAuth(reason);

    await expect(redirectTarget(renderedProducts())).resolves.toBe("/ja/access-suspended");

    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});

describe("商品一覧ページ: DB由来の認可（F-01-D）", () => {
  it("DB上の所属が店舗Bなら、JWTの店舗Aではなく店舗Bの商品を表示する", async () => {
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "STORE" } });

    const products = await renderedProducts();

    expect(mockedFindMany.mock.calls[0][0]).toMatchObject({ where: { shopId: SHOP_B.id } });
    expect(products?.map((p) => p.id)).toEqual([PRODUCT_B.id]);
  });

  it("実際の認可ヘルパー経由: JWTは店舗A・ADMIN、DBは店舗B・STOREなら店舗Bの商品だけを表示する", async () => {
    useRealAuthContext(SESSION_A, { id: USER_A.id, shopId: SHOP_B.id, role: "STORE", shop: { isActive: true } });

    const products = await renderedProducts();

    expect(mockedUserFindUnique.mock.calls[0][0]).toMatchObject({ where: { id: USER_A.id } });
    expect(mockedFindMany.mock.calls[0][0]).toMatchObject({ where: { shopId: SHOP_B.id } });
    expect(products?.map((p) => p.id)).toEqual([PRODUCT_B.id]);
    expect(JSON.stringify(mockedFindMany.mock.calls)).not.toContain(SHOP_A.id);
  });

  it.each([
    ["店舗が無効", { id: USER_A.id, shopId: SHOP_A.id, role: "ADMIN", shop: { isActive: false } }],
    ["ユーザーが削除済み", null],
  ])("実際の認可ヘルパー経由: DB上で%sなら、JWTが有効でも商品を取得せずアクセス停止画面へ遷移する", async (_label, dbUser) => {
    useRealAuthContext(SESSION_A, dbUser);

    await expect(redirectTarget(renderedProducts())).resolves.toBe("/ja/access-suspended");

    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("認可の確認（DB障害など）が例外なら、商品を取得せず、停止画面にも誘導しない", async () => {
    mockedAuthContext.mockRejectedValue(new Error("db down"));

    await expect(renderedProducts()).rejects.toThrow("db down");

    expect(mockedFindMany).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
