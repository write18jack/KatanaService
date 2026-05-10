// HTML取得
import fs from "fs";

export async function fetchHTML(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${url}`);
  }

  const html = await response.text();

  // console.log(html.slice(0, 5000))
  fs.writeFileSync("debug.html", html, "utf-8");

  return html;
}

// レート制限対策
export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
