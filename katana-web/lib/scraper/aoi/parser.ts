import * as cheerio from "cheerio";

// データ抽出

// -----------------------------
// 型
// -----------------------------
export type RawListing = {
  name: string;
  price: number | null;
  katanaType: string;
  era: string | null;
  sourceUrl: string;
};

// -----------------------------
// 一覧ページ → 詳細URL抽出
// -----------------------------
export function parseListingLinks(html: string): string[] {
  const $ = cheerio.load(html);

  const links: string[] = [];

  $(".jet-listing-grid__item").each((_, el) => {
    // <span class="jet-listing-dynamic-link__label">
    const href = $(el).find(".jet-listing-dynamic-link__link").attr("href");

    if (href) {
      links.push(href);
    }
  });

  return links;
}

// -----------------------------
// 詳細ページ → データ抽出p
// -----------------------------
export function parseDetail(html: string, url: string): RawListing {
  const $ = cheerio.load(html);

  const bodyText = $("body").text();

  // -----------------------------
  // 商品名
  // -----------------------------
  const name =
    //$("h1.entry-title").text().trim() || $("h1").first().text().trim();
    $(".jet-listing-dynamic-link__label").first().text().trim() ||
    $("h1.entry-title").first().text().trim() ||
    $("title").text().replace(" - Japanese Sword Shop Aoi-Art", "").trim();

  // -----------------------------
  // 価格
  // 450,000JPY に対応
  // -----------------------------
  const priceMatch =
    bodyText.match(/¥\s?([\d,]+)/i) || bodyText.match(/([\d,]+)\s?JPY/i);
  const price = priceMatch
    ? parseInt(priceMatch[1].replace(/,/g, ""), 10)
    : null;

  // -----------------------------
  // 刀種
  // -----------------------------
  const katanaType = detectKatanaType(name + " " + bodyText);

  // -----------------------------
  // 時代
  // -----------------------------
  const era = detectEra(bodyText);

  return {
    name,
    price,
    katanaType,
    era,
    sourceUrl: url,
  };
}

// -----------------------------
// 正規化（重要）
// -----------------------------
function detectKatanaType(text: string): string {
  const t = text.toLowerCase();

  if (t.includes("katana")) return "KATANA";
  if (t.includes("wakizashi")) return "WAKIZASHI";
  if (t.includes("tanto")) return "TANTO";

  return "UNKNOWN";
}

function detectEra(text: string): string | null {
  const t = text.toLowerCase();

  if (t.includes("edo")) return "EDO";
  if (t.includes("kamakura")) return "KAMAKURA";
  if (t.includes("muromachi")) return "MUROMACHI";

  return null;
}
