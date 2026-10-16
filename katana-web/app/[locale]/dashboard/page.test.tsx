import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

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

import { auth } from "@/auth";
import { getDashboardMarketSummary, getOwnShopProductCounts } from "@/lib/dashboard/dashboardData";
import { getMarketFilterMasters } from "@/lib/dashboard/marketFilterMasters";
import { SESSION_A, SESSION_B, SHOP_A, SHOP_B } from "@/lib/testing/tenantFixtures";
import { MarketMetricCard } from "./_components/MarketMetricCard";
import { MarketPriceTrendSection } from "./_components/MarketPriceTrendSection";
import { RecentImportsSection } from "./_components/RecentImportsSection";
import DashboardPage from "./page";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
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
    mockedAuth.mockResolvedValue(session);

    const tree = await renderPage();

    expect(mockedOwnCounts).toHaveBeenCalledTimes(1);
    expect(mockedOwnCounts).toHaveBeenCalledWith(shopId);
    expect(ownCardValues(tree)).toEqual(cards);
    const sections = findAll(tree, RecentImportsSection);
    expect(sections).toHaveLength(1);
    expect(sections[0].props).toEqual({ shopId });
  });

  it("URLにshopIdを指定しても、自店件数・取り込み履歴・市場集計は切り替わらない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    const tree = await renderPage({ shopId: SHOP_B.id });

    expect(mockedOwnCounts).toHaveBeenCalledWith(SHOP_A.id);
    expect(findAll(tree, RecentImportsSection)[0].props).toEqual({ shopId: SHOP_A.id });
    expect(mockedMarketSummary.mock.calls[0][0]).toEqual({});
    expect(JSON.stringify(mockedMarketSummary.mock.calls)).not.toContain(SHOP_B.id);
  });

  it("市場フィルターを変えても、自店件数と取り込み履歴の取得範囲は変わらない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

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
    mockedAuth.mockResolvedValue(SESSION_A);
    await renderPage();
    mockedAuth.mockResolvedValue(SESSION_B);
    await renderPage();

    expect(mockedMarketSummary).toHaveBeenCalledTimes(2);
    expect(mockedMarketSummary.mock.calls[0][0]).toEqual(mockedMarketSummary.mock.calls[1][0]);
    expect(mockedMarketSummary.mock.calls[0][0]).not.toHaveProperty("shopId");
  });

  it("未ログインでは自店データも市場データも取得しない", async () => {
    mockedAuth.mockResolvedValue(null);

    const tree = await renderPage();

    expect(mockedOwnCounts).not.toHaveBeenCalled();
    expect(mockedMarketSummary).not.toHaveBeenCalled();
    expect(findAll(tree, RecentImportsSection)).toHaveLength(0);
  });
});
