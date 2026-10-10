/**
 * 日本標準時（JST）はUTC+9固定（夏時間なし）。
 * システムのローカルタイムゾーンに依存しないよう、Date#getUTC*と固定オフセットのみで計算する。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const TREND_MONTH_COUNT = 12;

export type MonthEndSnapshot = {
  /** "2026/09" 形式のJST年月ラベル */
  label: string;
  /**
   * getPriceTrend/getMarketSnapshotAtへ渡すSnapshot時点。
   * 「翌月1日00:00 JST − 1ms」= 月末23:59:59.999 JST。
   * DBのDateTimeはTIMESTAMP(3)（ms精度）のため、Phase 2の
   * createdAt <= M / soldAt > M / changedAt <= M は
   * 「翌月1日00:00 JSTをexclusive upper boundとする」条件と厳密に同値になる。
   */
  asOf: Date;
};

/** JSTの year/month（monthは0始まり、範囲外は繰り上げ/繰り下げ）の1日00:00 JSTをUTCのDateで返す。 */
function startOfJstMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS);
}

function formatLabel(year: number, month: number): string {
  const normalized = new Date(Date.UTC(year, month, 1));
  const y = normalized.getUTCFullYear();
  const m = String(normalized.getUTCMonth() + 1).padStart(2, "0");
  return `${y}/${m}`;
}

/**
 * 直近の「確定済み」月末Snapshot（JST基準）を古い月→新しい月の順で返す。
 * 現在進行中のJST月は含めない。
 * 例: now = 2026-10-10 JST → 2025/10 〜 2026/09 の12点。
 */
export function getLastCompletedMonthEnds(now: Date, count: number = TREND_MONTH_COUNT): MonthEndSnapshot[] {
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const currentYear = jstNow.getUTCFullYear();
  const currentMonth = jstNow.getUTCMonth();

  const snapshots: MonthEndSnapshot[] = [];
  for (let offset = count; offset >= 1; offset--) {
    const month = currentMonth - offset;
    snapshots.push({
      label: formatLabel(currentYear, month),
      asOf: new Date(startOfJstMonth(currentYear, month + 1).getTime() - 1),
    });
  }
  return snapshots;
}
