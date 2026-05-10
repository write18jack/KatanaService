import { scrapeAoi } from "@/lib/scraper/aoi";

async function main() {
  console.log("Start scraping...");

  await scrapeAoi();

  console.log("Done.");
}

main();
