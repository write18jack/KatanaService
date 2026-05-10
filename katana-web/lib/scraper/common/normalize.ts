// src/lib/scraper/common/normalize.ts

// -----------------------------
// ENUM定義（DBと合わせる）
// -----------------------------
export enum KatanaType {
  KATANA = "KATANA",
  WAKIZASHI = "WAKIZASHI",
  TANTO = "TANTO",
  UNKNOWN = "UNKNOWN",
}

export enum Era {
  HEIAN = "HEIAN",
  KAMAKURA = "KAMAKURA",
  MUROMACHI = "MUROMACHI",
  MOMOYAMA = "MOMOYAMA",
  EDO = "EDO",
  MODERN = "MODERN",
  UNKNOWN = "UNKNOWN",
}

// -----------------------------
// KatanaType 正規化
// -----------------------------
export function normalizeKatanaType(text: string): KatanaType {
  const t = text.toLowerCase();

  if (t.includes("katana")) return KatanaType.KATANA;
  if (t.includes("wakizashi")) return KatanaType.WAKIZASHI;
  if (t.includes("tanto")) return KatanaType.TANTO;

  // 日本語対応
  if (t.includes("打刀")) return KatanaType.KATANA;
  if (t.includes("脇差")) return KatanaType.WAKIZASHI;
  if (t.includes("短刀")) return KatanaType.TANTO;

  return KatanaType.UNKNOWN;
}

// -----------------------------
// Era 正規化（最重要）
// -----------------------------
export function normalizeEra(text: string): Era {
  const t = text.toLowerCase();

  // 英語
  if (t.includes("edo")) return Era.EDO;
  if (t.includes("kamakura")) return Era.KAMAKURA;
  if (t.includes("muromachi")) return Era.MUROMACHI;
  if (t.includes("heian")) return Era.HEIAN;

  // 日本語
  if (t.includes("江戸")) return Era.EDO;
  if (t.includes("鎌倉")) return Era.KAMAKURA;
  if (t.includes("室町")) return Era.MUROMACHI;
  if (t.includes("平安")) return Era.HEIAN;

  // 曖昧表現（重要）
  if (t.includes("late edo")) return Era.EDO;
  if (t.includes("early edo")) return Era.EDO;

  return Era.UNKNOWN;
}

// -----------------------------
// Price 正規化
// -----------------------------
export function normalizePrice(text: string): number | null {
  if (!text) return null;

  // SOLD対応
  if (text.toLowerCase().includes("sold")) return null;

  const match = text.match(/([\d,]+)/);
  if (!match) return null;

  return parseInt(match[1].replace(/,/g, ""), 10);
}

// -----------------------------
// 共通 normalize
// -----------------------------
export function normalizeListing(raw: {
  name: string;
  price: number | null;
  katanaType: string;
  era: string | null;
  sourceUrl: string;
}) {
  const text = `${raw.name} ${raw.katanaType} ${raw.era ?? ""}`;

  return {
    name: raw.name.trim(),

    price: raw.price,

    katanaType: normalizeKatanaType(text),

    era: normalizeEra(text),

    sourceUrl: raw.sourceUrl,
  };
}
