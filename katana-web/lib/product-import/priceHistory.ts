/**
 * Import確定時にPriceHistoryを記録すべきかどうかを判定する。
 * 新規商品の場合はoldPriceにnullを渡す（「価格履歴なし」を表す）。
 */
export function shouldRecordPriceChange(
  oldPrice: number | null,
  newPrice: number | null,
): boolean {
  return oldPrice !== newPrice;
}
