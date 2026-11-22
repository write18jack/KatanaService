/**
 * 市場指標（平均価格・中央値）をDashboard表示用に丸める。
 * 「最も近い1円への四捨五入」で統一する（DBの元priceは変更しない）。
 * 例: 1320000.4 → 1320000 / 1320000.5 → 1320001
 */
export function roundToYen(value: number): number {
  return Math.round(value);
}

/**
 * 金額をDashboard表示用に¥区切り文字列へ整形する。
 * nullは価格データが無いことを示す「—」とし、¥0とは表示しない。
 */
export function formatYen(value: number | null): string {
  if (value === null) return "—";
  return `¥${roundToYen(value).toLocaleString("ja-JP")}`;
}

/**
 * 商品件数をDashboard表示用に整形する（刀剣の数え方「振」を単位とする）。
 */
export function formatCount(value: number): string {
  return `${value.toLocaleString("ja-JP")}振`;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 日時を日本時間（JST, UTC+9固定）の "YYYY/MM/DD HH:mm" へ整形する。
 * サーバーのローカルタイムゾーンに依存しないよう、固定オフセットとUTC getterのみを使う。
 * null/undefined/Invalid Dateはnullを返し、呼び出し側で「未記録」として扱う。
 */
export function formatJstDateTime(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;

  const jst = new Date(value.getTime() + JST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${jst.getUTCFullYear()}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}
