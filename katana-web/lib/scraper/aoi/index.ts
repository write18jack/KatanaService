import { prisma } from "@/lib/prisma";
import { CATEGORY_URLS, buildDetailUrl } from "./urls";
import { fetchHTML, sleep } from "./fetcher";
import { parseListingLinks, parseDetail } from "./parser";
import { KatanaType, Era } from "@prisma/client";

// 統合：実行ロジック

export async function scrapeAoi() {
  console.log("Start scraping AOI ART");

  for (const categoryUrl of CATEGORY_URLS) {
    console.log(`Fetching category: ${categoryUrl}`);

    const html = await fetchHTML(categoryUrl);

    const links = parseListingLinks(html);
    console.log(`Found ${links.length} items`);

    for (const link of links) {
      const url = buildDetailUrl(link);

      try {
        const detailHTML = await fetchHTML(url);

        const data = parseDetail(detailHTML, url);

        await upsertListing(data);

        await sleep(1000); // レート制限
      } catch (err) {
        console.error(`Error scraping ${url}`, err);
      }
    }
  }

  console.log("Finished scraping AOI ART");
}

// -----------------------------
// DB保存
// -----------------------------
async function upsertListing(data: {
  name: string;
  price: number | null;
  katanaType: KatanaType;
  era: Era;
  sourceUrl: string;
}) {
  const existing = await prisma.katanaListing.findUnique({
    where: { sourceUrl: data.sourceUrl },
  });

  if (!existing) {
    await prisma.katanaListing.create({
      data: {
        ...data,
        source: "aoi-art",
      },
    });
  } else {
    // 価格更新だけでもOK
    if (existing.price !== data.price) {
      await prisma.katanaListing.update({
        where: { id: existing.id },
        data: { price: data.price },
      });
    }
  }
}
