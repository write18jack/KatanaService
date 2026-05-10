// 取得対象URL

export const BASE_URL = "https://www.aoijapan.com";

export const CATEGORY_URLS = [
  `${BASE_URL}/katana/`,
  // MVPではこれだけでOK
  // `${BASE_URL}/wakizashi/`,
  // `${BASE_URL}/tanto/`,
];

export function buildDetailUrl(path: string) {
  if (path.startsWith("http")) return path;
  return `${BASE_URL}${path}`;
}
