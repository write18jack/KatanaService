import { extractRankCode, normalizeMasterValue, type MasterCaches } from "./masterCache";

// KatanaService Standard Import Format v1.0 の列（システム名）
export const IMPORT_COLUMNS = [
  "product_code",
  "name",
  "category",
  "maker",
  "appraiser",
  "grade",
  "rank",
  "period",
  "province",
  "sword_era",
  "price",
  "blade_length",
  "curvature",
] as const;

// ファイルの構造として最低限存在しなければならない列（値の必須/任意とは別軸）
export const STRUCTURALLY_REQUIRED_COLUMNS = ["product_code", "name", "category", "sword_era"];

export type ImportRowInput = Record<string, string>;

export type ValidatedRowData = {
  productCode: string;
  title: string;
  categoryId: string;
  makerId: string | null;
  appraiserId: string | null;
  gradeId: string | null;
  rankId: string | null;
  periodId: string | null;
  provinceId: string | null;
  swordEraId: string;
  price: number | null;
  bladeLength: number | null;
  curvature: number | null;
};

export type ValidateRowResult =
  | { status: "SUCCESS"; data: ValidatedRowData }
  | { status: "ERROR"; message: string }
  | { status: "SKIPPED" };

function cell(row: ImportRowInput, key: string): string {
  const value = row[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * 1行分の取込データを検証し、Masterへ解決したうえでProduct登録用データを組み立てる。
 * バリデーション/確定の両フェーズから同じロジックを共有するための純粋関数。
 * ファイル内重複チェックなど複数行にまたがる検証はここでは扱わない（呼び出し側の責務）。
 */
export function validateRow(row: ImportRowInput, masters: MasterCaches): ValidateRowResult {
  const allBlank = IMPORT_COLUMNS.every((key) => cell(row, key) === "");
  if (allBlank) {
    return { status: "SKIPPED" };
  }

  const errors: string[] = [];

  // product_code（必須）
  const productCode = cell(row, "product_code");
  if (productCode === "") {
    errors.push("商品コードは必須です。");
  } else if (productCode.length > 100) {
    errors.push("商品コードは100文字以内で入力してください。");
  }

  // name（必須）
  const title = cell(row, "name");
  if (title === "") {
    errors.push("品名は必須です。");
  } else if (title.length > 255) {
    errors.push("品名は255文字以内で入力してください。");
  }

  // category（必須・Master）
  const categoryRaw = cell(row, "category");
  let categoryId: string | null = null;
  if (categoryRaw === "") {
    errors.push("種類は必須です。");
  } else {
    categoryId = masters.categories.get(normalizeMasterValue(categoryRaw)) ?? null;
    if (!categoryId) {
      errors.push(`種類がマスタと一致しません: ${categoryRaw}`);
    }
  }

  // maker（任意・Master）
  const makerRaw = cell(row, "maker");
  let makerId: string | null = null;
  if (makerRaw !== "") {
    makerId = masters.makers.get(normalizeMasterValue(makerRaw)) ?? null;
    if (!makerId) {
      errors.push(`作者・刀匠がマスタと一致しません: ${makerRaw}`);
    }
  }

  // appraiser（任意・Master）
  const appraiserRaw = cell(row, "appraiser");
  let appraiserId: string | null = null;
  if (appraiserRaw !== "") {
    appraiserId = masters.appraisers.get(normalizeMasterValue(appraiserRaw)) ?? null;
    if (!appraiserId) {
      errors.push(`鑑定者がマスタと一致しません: ${appraiserRaw}`);
    }
  }

  // grade（任意・Master）
  const gradeRaw = cell(row, "grade");
  let gradeId: string | null = null;
  if (gradeRaw !== "") {
    gradeId = masters.grades.get(normalizeMasterValue(gradeRaw)) ?? null;
    if (!gradeId) {
      errors.push(`格付けがマスタと一致しません: ${gradeRaw}`);
    }
  }

  // rank（任意・Masterのコード部分と照合）
  const rankRaw = cell(row, "rank");
  let rankId: string | null = null;
  if (rankRaw !== "") {
    rankId = masters.ranks.get(extractRankCode(rankRaw)) ?? null;
    if (!rankId) {
      errors.push(`ランクがマスタと一致しません: ${rankRaw}`);
    }
  }

  // period（任意・Master）
  const periodRaw = cell(row, "period");
  let periodId: string | null = null;
  if (periodRaw !== "") {
    periodId = masters.periods.get(normalizeMasterValue(periodRaw)) ?? null;
    if (!periodId) {
      errors.push(`製作年代がマスタと一致しません: ${periodRaw}`);
    }
  }

  // province（任意・Master）
  const provinceRaw = cell(row, "province");
  let provinceId: string | null = null;
  if (provinceRaw !== "") {
    provinceId = masters.provinces.get(normalizeMasterValue(provinceRaw)) ?? null;
    if (!provinceId) {
      errors.push(`製作場所がマスタと一致しません: ${provinceRaw}`);
    }
  }

  // sword_era（必須・Master）
  const swordEraRaw = cell(row, "sword_era");
  let swordEraId: string | null = null;
  if (swordEraRaw === "") {
    errors.push("区分は必須です。");
  } else {
    swordEraId = masters.swordEras.get(normalizeMasterValue(swordEraRaw)) ?? null;
    if (!swordEraId) {
      errors.push(`区分がマスタと一致しません: ${swordEraRaw}`);
    }
  }

  // price（任意）：空欄→null、1以上の整数のみ有効
  const priceRaw = cell(row, "price");
  let price: number | null = null;
  if (priceRaw !== "") {
    const parsed = Number(priceRaw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      errors.push(`販売価格は1以上の整数で入力してください: ${priceRaw}`);
    } else {
      price = parsed;
    }
  }

  // blade_length（任意）：空欄→null、0より大きい数値のみ有効
  const bladeLengthRaw = cell(row, "blade_length");
  let bladeLength: number | null = null;
  if (bladeLengthRaw !== "") {
    const parsed = Number(bladeLengthRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push(`刃長は0より大きい数値で入力してください: ${bladeLengthRaw}`);
    } else {
      bladeLength = parsed;
    }
  }

  // curvature（任意）：空欄→null、0以上の数値のみ有効
  const curvatureRaw = cell(row, "curvature");
  let curvature: number | null = null;
  if (curvatureRaw !== "") {
    const parsed = Number(curvatureRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push(`反りは0以上の数値で入力してください: ${curvatureRaw}`);
    } else {
      curvature = parsed;
    }
  }

  if (errors.length > 0) {
    return { status: "ERROR", message: errors.join(" / ") };
  }

  return {
    status: "SUCCESS",
    data: {
      productCode,
      title,
      categoryId: categoryId as string,
      makerId,
      appraiserId,
      gradeId,
      rankId,
      periodId,
      provinceId,
      swordEraId: swordEraId as string,
      price,
      bladeLength,
      curvature,
    },
  };
}
