import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 履歴系テーブル（ProductHistory / PriceHistory / ImportRow）を「読み取る」コードの棚卸し。
 * 店舗をまたいで履歴を読む経路が増えていないことを静的に検証する。
 * 新しい読み取り経路を追加したら、その経路に店舗の認可があることを確認したうえでここへ追記する。
 */
const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["app", "actions", "lib", "data", "components"];
const EXCLUDE = [/\.test\.tsx?$/, /^lib\/generated\//, /^lib\/testing\//, /^lib\/market-analytics\/testHelpers\.ts$/];

const READ_PATTERNS: Record<string, RegExp[]> = {
  ProductHistory: [/\.productHistory\.(find|count|aggregate|groupBy)/, /"ProductHistory"/, /\bhistories\s*:/],
  PriceHistory: [/\.priceHistory\.(find|count|aggregate|groupBy)/, /"PriceHistory"/, /\bpriceHistories\s*:/],
  // `rows: { create: … }` はジョブ作成時の入れ子書き込みなので対象外。読み取りは include 経由のみを拾う
  ImportRow: [/\.importRow\.(find|count|aggregate|groupBy)/, /"ImportRow"/, /include:\s*\{[^}]*\brows\b/],
};

/** 既知の読み取り経路と、その経路の認可の根拠 */
const ALLOWED: Record<string, Record<string, string>> = {
  ProductHistory: {},
  PriceHistory: {
    "lib/market-analytics/priceTrend.ts": "市場全体の集計値のみを返す（個別の履歴行は返さない）",
  },
  ImportRow: {
    "app/[locale]/dashboard/import/[jobId]/page.tsx": "ジョブのshopIdをセッションと照合してから描画",
    "actions/product-import/confirm.ts": "ジョブのshopIdをセッションと照合してから処理",
    "lib/dashboard/recentImports.ts": "importJob.shopIdで絞ったgroupBy（件数のみ）",
  },
};

function sourceFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = path.posix.join(dir, entry);
    if (statSync(path.join(ROOT, relative)).isDirectory()) return sourceFiles(relative);
    return /\.(ts|tsx)$/.test(entry) && !EXCLUDE.some((re) => re.test(relative)) ? [relative] : [];
  });
}

const files = SCAN_DIRS.flatMap(sourceFiles);

describe("履歴データの読み取り経路", () => {
  it("走査対象のソースが存在する（走査漏れの検出）", () => {
    expect(files).toContain("actions/product-import/confirm.ts");
    expect(files).toContain("app/[locale]/dashboard/import/[jobId]/page.tsx");
  });

  it.each(Object.keys(READ_PATTERNS))("%s を読み取るコードは既知の認可済み経路だけ", (model) => {
    const readers = files.filter((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      return READ_PATTERNS[model].some((re) => re.test(source));
    });

    expect(readers.sort()).toEqual(Object.keys(ALLOWED[model]).sort());
  });
});
