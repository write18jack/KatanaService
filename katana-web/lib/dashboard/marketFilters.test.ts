import { describe, expect, it } from "vitest";
import { marketFilterWhere } from "@/lib/market-analytics/filters";
import {
  buildFilterHref,
  buildResetSearchParams,
  buildUpdatedSearchParams,
  hasMarketFilterParams,
  MARKET_FILTER_FIELDS,
  resolveMarketFilters,
  type MarketFilterMasterOptions,
} from "./marketFilters";

function masters(overrides: Partial<MarketFilterMasterOptions> = {}): MarketFilterMasterOptions {
  const base: MarketFilterMasterOptions = {
    categoryId: [{ id: "cat-1", name: "刀" }],
    gradeId: [{ id: "grade-1", name: "特別保存刀剣" }],
    rankId: [{ id: "rank-1", name: "A" }],
    periodId: [{ id: "period-1", name: "江戸後期" }],
    provinceId: [{ id: "province-1", name: "備前" }],
    swordEraId: [{ id: "era-1", name: "新刀" }],
    makerId: [{ id: "maker-1", name: "テスト刀匠" }],
    appraiserId: [{ id: "appraiser-1", name: "テスト鑑定者" }],
  };
  return { ...base, ...overrides };
}

describe("resolveMarketFilters", () => {
  it("filter未指定の場合はMarketFiltersに含めない（無効通知もしない）", () => {
    const { filters, invalidKeys } = resolveMarketFilters({}, masters());
    expect(filters).toEqual({});
    expect(invalidKeys).toEqual([]);
  });

  it("正常なcategoryIdを受理する", () => {
    const { filters, invalidKeys } = resolveMarketFilters({ categoryId: "cat-1" }, masters());
    expect(filters).toEqual({ categoryId: "cat-1" });
    expect(invalidKeys).toEqual([]);
  });

  it("正常なgradeIdを受理する", () => {
    const { filters, invalidKeys } = resolveMarketFilters({ gradeId: "grade-1" }, masters());
    expect(filters).toEqual({ gradeId: "grade-1" });
    expect(invalidKeys).toEqual([]);
  });

  it("複数の正常filterをすべて受理する（AND対象として）", () => {
    const { filters, invalidKeys } = resolveMarketFilters(
      { categoryId: "cat-1", gradeId: "grade-1", provinceId: "province-1" },
      masters(),
    );
    expect(filters).toEqual({ categoryId: "cat-1", gradeId: "grade-1", provinceId: "province-1" });
    expect(invalidKeys).toEqual([]);
  });

  it("存在しないMaster IDは無効として除外する", () => {
    const { filters, invalidKeys } = resolveMarketFilters({ categoryId: "does-not-exist" }, masters());
    expect(filters).toEqual({});
    expect(invalidKeys).toEqual(["categoryId"]);
  });

  it("inactiveなMaster ID（=masters一覧に含まれないID）は無効として除外する", () => {
    // getMarketFilterMastersはisActive=trueのみ返すため、inactiveなMasterのIDは
    // 「masters一覧に存在しないID」として表現される。
    const inactiveId = "inactive-grade-id";
    const { filters, invalidKeys } = resolveMarketFilters({ gradeId: inactiveId }, masters());
    expect(filters).toEqual({});
    expect(invalidKeys).toEqual(["gradeId"]);
  });

  it("空文字列は無効として除外する", () => {
    const { filters, invalidKeys } = resolveMarketFilters({ categoryId: "" }, masters());
    expect(filters).toEqual({});
    expect(invalidKeys).toEqual(["categoryId"]);
  });

  it("同一keyの重複（配列）は無効として除外する", () => {
    const { filters, invalidKeys } = resolveMarketFilters({ categoryId: ["cat-1", "cat-1-dup"] }, masters());
    expect(filters).toEqual({});
    expect(invalidKeys).toEqual(["categoryId"]);
  });

  it("未対応のquery keyは無視する（フィルターとして扱わない）", () => {
    const { filters, invalidKeys } = resolveMarketFilters({ unknownKey: "whatever" }, masters());
    expect(filters).toEqual({});
    expect(invalidKeys).toEqual([]);
  });

  it("有効・無効条件が混在する場合、有効なもののみ適用し無効keyのみ通知する", () => {
    const { filters, invalidKeys } = resolveMarketFilters(
      { categoryId: "cat-1", gradeId: "does-not-exist", rankId: ["dup-1", "dup-2"] },
      masters(),
    );
    expect(filters).toEqual({ categoryId: "cat-1" });
    expect(invalidKeys.sort()).toEqual(["gradeId", "rankId"]);
  });

  it("8種類すべてのfilter keyを同時に検証できる", () => {
    const raw = {
      categoryId: "cat-1",
      gradeId: "grade-1",
      rankId: "rank-1",
      periodId: "period-1",
      provinceId: "province-1",
      swordEraId: "era-1",
      makerId: "maker-1",
      appraiserId: "appraiser-1",
    };
    const { filters, invalidKeys } = resolveMarketFilters(raw, masters());
    expect(filters).toEqual(raw);
    expect(invalidKeys).toEqual([]);
    expect(MARKET_FILTER_FIELDS).toHaveLength(8);
  });
});

describe("buildUpdatedSearchParams", () => {
  it("「すべて」（value=null）を選択した場合、そのkeyをURLから削除する", () => {
    const current = new URLSearchParams("categoryId=cat-1&gradeId=grade-1");
    const next = buildUpdatedSearchParams(current, "categoryId", null);
    expect(next.has("categoryId")).toBe(false);
    expect(next.get("gradeId")).toBe("grade-1");
  });

  it("1つのフィルターを変更しても他の条件は維持される", () => {
    const current = new URLSearchParams("categoryId=cat-1&gradeId=grade-1&provinceId=province-1");
    const next = buildUpdatedSearchParams(current, "gradeId", "grade-2");
    expect(next.get("categoryId")).toBe("cat-1");
    expect(next.get("gradeId")).toBe("grade-2");
    expect(next.get("provinceId")).toBe("province-1");
  });

  it("無関係なquery parameterも維持される", () => {
    const current = new URLSearchParams("foo=bar");
    const next = buildUpdatedSearchParams(current, "categoryId", "cat-1");
    expect(next.get("foo")).toBe("bar");
    expect(next.get("categoryId")).toBe("cat-1");
  });
});

describe("buildResetSearchParams", () => {
  it("8つの市場フィルターをすべてURLから削除する", () => {
    const current = new URLSearchParams(
      "categoryId=a&gradeId=b&rankId=c&periodId=d&provinceId=e&swordEraId=f&makerId=g&appraiserId=h",
    );
    const next = buildResetSearchParams(current);
    for (const { key } of MARKET_FILTER_FIELDS) {
      expect(next.has(key)).toBe(false);
    }
  });

  it("市場フィルターと無関係なparameterは保持する", () => {
    const current = new URLSearchParams("categoryId=a&foo=bar");
    const next = buildResetSearchParams(current);
    expect(next.has("categoryId")).toBe(false);
    expect(next.get("foo")).toBe("bar");
  });
});

describe("MarketFilters semantics", () => {
  it("検証済みの複数条件はPhase 2のmarketFilterWhereでAND条件になる", () => {
    const { filters } = resolveMarketFilters(
      { categoryId: "cat-1", gradeId: "grade-1", provinceId: "province-1" },
      masters(),
    );
    expect(marketFilterWhere(filters)).toEqual({
      categoryId: "cat-1",
      gradeId: "grade-1",
      provinceId: "province-1",
    });
  });

  it("未指定・無効なkeyは空文字列や\"ALL\"としてではなくproperty自体が存在しない", () => {
    const { filters } = resolveMarketFilters({ categoryId: "", gradeId: "ALL", rankId: "rank-1" }, masters());
    expect(Object.keys(filters)).toEqual(["rankId"]);
  });
});

describe("hasMarketFilterParams", () => {
  it("市場フィルターkeyが無ければfalse", () => {
    expect(hasMarketFilterParams(new URLSearchParams("foo=bar"))).toBe(false);
  });

  it("無効値・重複を含む市場フィルターkeyがあればtrue（リセット可能）", () => {
    expect(hasMarketFilterParams(new URLSearchParams("categoryId="))).toBe(true);
    expect(hasMarketFilterParams(new URLSearchParams("gradeId=a&gradeId=b"))).toBe(true);
  });
});

describe("buildFilterHref", () => {
  it("query stringがあればpathnameに付与する", () => {
    expect(buildFilterHref("/dashboard", new URLSearchParams("categoryId=cat-1&gradeId=grade-1"))).toBe(
      "/dashboard?categoryId=cat-1&gradeId=grade-1",
    );
  });

  it("queryが空ならpathnameのみ（末尾の?を付けない）", () => {
    expect(buildFilterHref("/dashboard", new URLSearchParams())).toBe("/dashboard");
  });

  it("localeを付与・除去しない（localeはnext-intlのrouterが付与する）", () => {
    const href = buildFilterHref("/dashboard", buildResetSearchParams(new URLSearchParams("categoryId=a")));
    expect(href).toBe("/dashboard");
    expect(href.startsWith("/ja")).toBe(false);
    expect(href.startsWith("/en")).toBe(false);
  });

  it("重複keyのあるURLでSelectを変更すると、そのkeyは単一値に置き換わる", () => {
    const next = buildUpdatedSearchParams(new URLSearchParams("categoryId=a&categoryId=b"), "categoryId", "cat-1");
    expect(next.getAll("categoryId")).toEqual(["cat-1"]);
  });
});
