import { prisma } from "@/lib/prisma";

export type MasterCaches = {
  categories: Map<string, string>;
  makers: Map<string, string>;
  appraisers: Map<string, string>;
  grades: Map<string, string>;
  periods: Map<string, string>;
  provinces: Map<string, string>;
  swordEras: Map<string, string>;
  // key: ランクのコード部分（「（」より前）を正規化・大文字化したもの
  ranks: Map<string, string>;
};

/**
 * Master値の基本的な正規化：前後空白のトリム＋全角/半角等の表記ゆれ吸収（NFKC）。
 */
export function normalizeMasterValue(value: string): string {
  return value.trim().normalize("NFKC");
}

/**
 * Rank.name は "B（最良好　★★☆　研ぎ痕少々あり）" のような複合文字列で
 * 保存されているため、インポートファイルの入力値（例: "B"）と直接一致しない。
 * 「（」より前のコード部分だけを取り出して照合キーとする。
 */
export function extractRankCode(rankName: string): string {
  const idx = rankName.indexOf("（");
  const code = idx === -1 ? rankName : rankName.slice(0, idx);
  return normalizeMasterValue(code).toUpperCase();
}

function toNameMap(records: { id: string; name: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of records) {
    map.set(normalizeMasterValue(record.name), record.id);
  }
  return map;
}

/**
 * 有効なMasterレコードを一括取得し、正規化済みの値→idのMapを構築する。
 * 行数分だけMasterへ都度クエリしないよう、インポートジョブ単位で1回だけ呼び出す想定。
 */
export async function loadMasterCaches(): Promise<MasterCaches> {
  const [categories, makers, appraisers, grades, periods, provinces, swordEras, ranks] =
    await Promise.all([
      prisma.category.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.maker.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.appraiser.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.grade.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.period.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.province.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.swordEra.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.rank.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    ]);

  const rankMap = new Map<string, string>();
  for (const rank of ranks) {
    rankMap.set(extractRankCode(rank.name), rank.id);
  }

  return {
    categories: toNameMap(categories),
    makers: toNameMap(makers),
    appraisers: toNameMap(appraisers),
    grades: toNameMap(grades),
    periods: toNameMap(periods),
    provinces: toNameMap(provinces),
    swordEras: toNameMap(swordEras),
    ranks: rankMap,
  };
}
