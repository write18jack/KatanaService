/**
 * 市場分析5指標すべてで共通利用するFilter。
 * 指定されていないFilterは無視し、複数指定時はAND条件となる。
 * Shop.isActive=trueは各metric関数側で必ず適用する共通条件であり、
 * ここには含めない。
 */
export type MarketFilters = {
  categoryId?: string;
  gradeId?: string;
  rankId?: string;
  periodId?: string;
  provinceId?: string;
  swordEraId?: string;
  makerId?: string;
  appraiserId?: string;
};

export type MarketAverageResult = {
  averagePrice: number | null;
  disclosedPriceCount: number;
  totalInventoryCount: number;
};

export type MarketSnapshot = {
  inventoryCount: number;
  disclosedPriceCount: number;
  averagePrice: number | null;
  medianPrice: number | null;
};

export type MarketTrendPoint = MarketSnapshot & {
  date: Date;
};

/**
 * PostgreSQL raw queryの戻り値（number / string / Decimal-like のいずれかが
 * ドライバ経由で返りうる）をDashboard側が安全に扱えるnumberへ正規化する。
 */
export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  if (
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}
