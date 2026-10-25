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
  return { RedirectSignal, locale: "ja" };
});

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => nav.locale,
}));

vi.mock("@/i18n/navigation", () => ({
  redirect: vi.fn(({ href, locale }: { href: string; locale: string }) => {
    throw new nav.RedirectSignal(href, locale);
  }),
  Link: ({ children }: { children: ReactNode }) => children,
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signOut: vi.fn(),
}));

// 認可はDB由来のコンテキストで行う。ページのテストでは結果をモックし、DB照合そのものは lib/auth/context.test.ts で検証する
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getAuthContext: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/dashboard/dashboardData", () => ({
  getDashboardMarketSummary: vi.fn(),
  getOwnShopProductCounts: vi.fn(),
  getDashboardPriceTrend: vi.fn(),
}));

vi.mock("@/lib/dashboard/marketFilterMasters", () => ({
  getMarketFilterMasters: vi.fn(),
}));

import type { UserRole } from "@prisma/client";
import { auth, signOut } from "@/auth";
import { redirect } from "@/i18n/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { getDashboardMarketSummary, getOwnShopProductCounts } from "@/lib/dashboard/dashboardData";
import { getMarketFilterMasters } from "@/lib/dashboard/marketFilterMasters";
import { SESSION_A, SESSION_B, SHOP_A, SHOP_B, USER_A } from "@/lib/testing/tenantFixtures";
import { MarketMetricCard } from "./_components/MarketMetricCard";
import { MarketPriceTrendSection } from "./_components/MarketPriceTrendSection";
import { RecentImportsSection } from "./_components/RecentImportsSection";
import DashboardPage from "./page";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedAuthContext = vi.mocked(getAuthContext);

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

function expectNoDashboardData() {
  expect(getMarketFilterMasters).not.toHaveBeenCalled();
  expect(mockedOwnCounts).not.toHaveBeenCalled();
  expect(mockedMarketSummary).not.toHaveBeenCalled();
}
const mockedOwnCounts = vi.mocked(getOwnShopProductCounts);
const mockedMarketSummary = vi.mocked(getDashboardMarketSummary);

const OWN_COUNTS: Record<string, { activeCount: number; soldCount: number }> = {
  [SHOP_A.id]: { activeCount: 20, soldCount: 1 },
  [SHOP_B.id]: { activeCount: 3, soldCount: 7 },
};

function findAll(node: ReactNode, type: unknown, found: Array<ReactElement<Record<string, unknown>>> = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found);
  } else if (isValidElement<Record<string, unknown>>(node)) {
    if (node.type === type) found.push(node);
    findAll(node.props.children as ReactNode, type, found);
  }
  return found;
}

async function renderPage(searchParams: Record<string, string | string[]> = {}) {
  return DashboardPage({ searchParams: Promise.resolve(searchParams) });
}

function ownCardValues(tree: ReactNode) {
  return Object.fromEntries(
    findAll(tree, MarketMetricCard)
      .filter((card) => card.props.label === "販売中" || card.props.label === "SOLD")
      .map((card) => [card.props.label, card.props.value]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuthContext.mockReset();
  nav.locale = "ja";
  vi.mocked(getMarketFilterMasters).mockResolvedValue({
    categoryId: [{ id: "category-katana", name: "刀" }],
    gradeId: [],
    rankId: [],
    periodId: [],
    provinceId: [],
    swordEraId: [],
    makerId: [],
    appraiserId: [],
  });
  mockedOwnCounts.mockImplementation(async (shopId: string) => OWN_COUNTS[shopId] ?? { activeCount: 0, soldCount: 0 });
  mockedMarketSummary.mockResolvedValue({
    inventoryCount: 23,
    average: { averagePrice: 1000000, disclosedPriceCount: 20, totalInventoryCount: 23 },
    medianPrice: 900000,
    soldCount: 8,
  });
});

describe("Dashboard: 自店データの店舗分離", () => {
  it.each([
    ["店舗A", SESSION_A, SHOP_A.id, { 販売中: "20振", SOLD: "1振" }],
    ["店舗B", SESSION_B, SHOP_B.id, { 販売中: "3振", SOLD: "7振" }],
  ])("%sでログインすると、自店件数と取り込み履歴はその店舗のshopIdで取得される", async (_label, session, shopId, cards) => {
    signInAs(session);

    const tree = await renderPage();

    expect(mockedOwnCounts).toHaveBeenCalledTimes(1);
    expect(mockedOwnCounts).toHaveBeenCalledWith(shopId);
    expect(ownCardValues(tree)).toEqual(cards);
    const sections = findAll(tree, RecentImportsSection);
    expect(sections).toHaveLength(1);
    expect(sections[0].props).toEqual({ shopId });
  });

  it("URLにshopIdを指定しても、自店件数・取り込み履歴・市場集計は切り替わらない", async () => {
    signInAs(SESSION_A);

    const tree = await renderPage({ shopId: SHOP_B.id });

    expect(mockedOwnCounts).toHaveBeenCalledWith(SHOP_A.id);
    expect(findAll(tree, RecentImportsSection)[0].props).toEqual({ shopId: SHOP_A.id });
    expect(mockedMarketSummary.mock.calls[0][0]).toEqual({});
    expect(JSON.stringify(mockedMarketSummary.mock.calls)).not.toContain(SHOP_B.id);
  });

  it("市場フィルターを変えても、自店件数と取り込み履歴の取得範囲は変わらない", async () => {
    signInAs(SESSION_A);

    const unfiltered = await renderPage();
    const filtered = await renderPage({ categoryId: "category-katana" });

    expect(mockedOwnCounts.mock.calls).toEqual([[SHOP_A.id], [SHOP_A.id]]);
    expect(findAll(unfiltered, RecentImportsSection)[0].props).toEqual({ shopId: SHOP_A.id });
    expect(findAll(filtered, RecentImportsSection)[0].props).toEqual({ shopId: SHOP_A.id });
    // フィルターは市場集計と相場推移にだけ渡る
    expect(mockedMarketSummary.mock.calls[1][0]).toEqual({ categoryId: "category-katana" });
    expect(findAll(filtered, MarketPriceTrendSection)[0].props).toEqual({ filters: { categoryId: "category-katana" } });
  });

  it("市場KPIは店舗で絞らず全有効店舗が対象（店舗A・Bで同じ条件・同じ値）", async () => {
    signInAs(SESSION_A);
    await renderPage();
    signInAs(SESSION_B);
    await renderPage();

    expect(mockedMarketSummary).toHaveBeenCalledTimes(2);
    expect(mockedMarketSummary.mock.calls[0][0]).toEqual(mockedMarketSummary.mock.calls[1][0]);
    expect(mockedMarketSummary.mock.calls[0][0]).not.toHaveProperty("shopId");
  });

  it("未ログインでは自店データも市場データも取得せず、ログイン画面へ遷移する", async () => {
    denyAuth("UNAUTHENTICATED");

    await expect(redirectTarget(renderPage())).resolves.toBe("/ja/login");

    expect(mockedOwnCounts).not.toHaveBeenCalled();
    expect(mockedMarketSummary).not.toHaveBeenCalled();
  });
});

describe("Dashboard: DB由来の認可（F-01-D）", () => {
  it.each([
    ["無効店舗", "SHOP_INACTIVE"],
    ["削除済みユーザー", "USER_NOT_FOUND"],
  ] as const)("%sは市場分析も自店データも取得せず、アクセス停止画面へ遷移する", async (_label, reason) => {
    denyAuth(reason);

    await expect(redirectTarget(renderPage())).resolves.toBe("/ja/access-suspended");

    expectNoDashboardData();
    // 停止時に自動ログアウトしない（セッションを残し、再有効化後に再開できるようにする）
    expect(signOut).not.toHaveBeenCalled();
  });

  it("英語ロケールでは英語のアクセス停止画面・ログイン画面へ遷移する", async () => {
    nav.locale = "en";

    denyAuth("SHOP_INACTIVE");
    await expect(redirectTarget(renderPage())).resolves.toBe("/en/access-suspended");
    denyAuth("UNAUTHENTICATED");
    await expect(redirectTarget(renderPage())).resolves.toBe("/en/login");
  });

  it("DB上の所属が店舗Bなら、JWTの店舗Aではなく店舗Bの自店データを表示する", async () => {
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "STORE" } });

    const tree = await renderPage();

    expect(mockedOwnCounts).toHaveBeenCalledWith(SHOP_B.id);
    expect(ownCardValues(tree)).toEqual({ 販売中: "3振", SOLD: "7振" });
    expect(findAll(tree, RecentImportsSection)[0].props).toEqual({ shopId: SHOP_B.id });
    expect(JSON.stringify(mockedOwnCounts.mock.calls)).not.toContain(SHOP_A.id);
  });

  it("DB上のロールがSTORE（JWTはADMIN）でも、ロールに依存しない既存の表示はDB由来の値で行う", async () => {
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_A.id, role: "STORE" } });

    const tree = await renderPage();

    expect(ownCardValues(tree)).toEqual({ 販売中: "20振", SOLD: "1振" });
    expect(mockedMarketSummary).toHaveBeenCalledTimes(1);
  });

  it("認可の確認（DB障害など）が例外なら、業務データを取得せず、停止画面・ログイン画面にも誘導しない", async () => {
    mockedAuthContext.mockRejectedValue(new Error("db down"));

    await expect(renderPage()).rejects.toThrow("db down");

    expectNoDashboardData();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("店舗が再有効化されれば、同じセッションのまま再ログインせずに表示できる", async () => {
    denyAuth("SHOP_INACTIVE");
    await expect(redirectTarget(renderPage())).resolves.toBe("/ja/access-suspended");

    signInAs(SESSION_A);
    const tree = await renderPage();

    expect(ownCardValues(tree)).toEqual({ 販売中: "20振", SOLD: "1振" });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("ページは auth() を直接呼ばず、getAuthContext() で認可する", async () => {
    signInAs(SESSION_A);

    await renderPage();

    expect(mockedAuthContext).toHaveBeenCalledTimes(1);
    expect(mockedAuth).not.toHaveBeenCalled();
  });
});
