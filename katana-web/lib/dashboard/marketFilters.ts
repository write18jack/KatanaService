import type { MarketFilters } from "@/lib/market-analytics/types";

/**
 * Dashboard市場フィルターの単一ソース（URL key・表示名・対象Master）。
 * Phase 3-Cの相場チャートでも同じMarketFiltersをそのまま再利用する想定のため、
 * Dashboard page内に検証ロジックを直接書かず、このファイルへ集約する。
 *
 * このファイルはPrisma等のサーバー専用importを含めない（MarketFilterBarが
 * Client Componentからこのファイルの定数・純粋関数をimportするため）。
 * Prismaを使うMaster取得は marketFilterMasters.ts へ分離している。
 */
export const MARKET_FILTER_FIELDS = [
  { key: "categoryId", label: "種類" },
  { key: "gradeId", label: "格付け" },
  { key: "rankId", label: "保存状態" },
  { key: "periodId", label: "製作年代" },
  { key: "provinceId", label: "製作場所" },
  { key: "swordEraId", label: "区分" },
  { key: "makerId", label: "作者・刀匠" },
  { key: "appraiserId", label: "鑑定者" },
] as const satisfies ReadonlyArray<{ key: keyof MarketFilters; label: string }>;

export type MarketFilterKey = (typeof MARKET_FILTER_FIELDS)[number]["key"];

export type MasterOption = { id: string; name: string };

export type MarketFilterMasterOptions = Record<MarketFilterKey, MasterOption[]>;

/** Next.jsのPage propsが渡すsearchParamsの形（同一keyが複数あると配列になる）。 */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * URLパラメータをMarketFiltersへ検証・変換する純粋関数。
 *
 * - 8つの対応keyのみを見る（未対応keyは無視し、URLにも残す）
 * - 未指定 → MarketFiltersに含めない（通知もしない）
 * - 配列（同一keyの重複） → 無効として除外
 * - 空文字列 → 無効として除外
 * - 対応するMaster（isActive=true）に存在しないID → 無効として除外
 * - 有効な値のみMarketFiltersへ格納
 *
 * 無効だったkeyはinvalidKeysに積み、呼び出し側でUI通知に使う。
 */
export function resolveMarketFilters(
  rawSearchParams: RawSearchParams,
  masters: MarketFilterMasterOptions,
): { filters: MarketFilters; invalidKeys: MarketFilterKey[] } {
  const filters: MarketFilters = {};
  const invalidKeys: MarketFilterKey[] = [];

  for (const { key } of MARKET_FILTER_FIELDS) {
    const raw = rawSearchParams[key];

    if (raw === undefined) continue;

    if (Array.isArray(raw) || raw === "") {
      invalidKeys.push(key);
      continue;
    }

    const isValidId = masters[key].some((option) => option.id === raw);
    if (!isValidId) {
      invalidKeys.push(key);
      continue;
    }

    filters[key] = raw;
  }

  return { filters, invalidKeys };
}

/**
 * 現在のURLSearchParamsを基に、1つのフィルターkeyだけを更新した新しいURLSearchParamsを返す。
 * value=nullは「すべて」選択を意味し、そのkeyをURLから削除する。他のkeyは一切変更しない。
 */
export function buildUpdatedSearchParams(
  current: URLSearchParams,
  key: MarketFilterKey,
  value: string | null,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (value === null) {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  return next;
}

/**
 * 8つの市場フィルターkeyのみをURLから削除した新しいURLSearchParamsを返す。
 * 市場フィルターと無関係なkeyはそのまま保持する。
 */
export function buildResetSearchParams(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const { key } of MARKET_FILTER_FIELDS) {
    next.delete(key);
  }
  return next;
}

/**
 * URLに市場フィルターkeyが1つでも含まれているか（無効値・重複を含む）。
 * リセット操作の有効/無効判定に使う。
 */
export function hasMarketFilterParams(current: URLSearchParams): boolean {
  return MARKET_FILTER_FIELDS.some(({ key }) => current.has(key));
}

/**
 * locale無しのpathname（next-intlのusePathnameの戻り値）とquery stringから遷移先hrefを作る。
 * localeの付与はnext-intlのrouterに任せるため、ここではlocaleを扱わない。
 */
export function buildFilterHref(pathname: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
