import type { MarketTrendPoint } from "@/lib/market-analytics/types";

/**
 * Client Component（チャート）へ渡す1点分のデータ。
 * Dateを含めずシリアライズ可能な値のみとし、価格nullは欠損値としてnullのまま保持する。
 * 店舗情報は含めない。
 */
export type PriceTrendChartPoint = {
  label: string;
  averagePrice: number | null;
  medianPrice: number | null;
  inventoryCount: number;
  disclosedPriceCount: number;
};

/**
 * getPriceTrendの結果をチャート用データへ変換する。
 * 平均・中央値は再計算せずPhase 2の値をそのまま使い、順序も維持する。
 */
export function toPriceTrendChartData(
  points: MarketTrendPoint[],
  labels: string[],
): PriceTrendChartPoint[] {
  return points.map((point, index) => ({
    label: labels[index],
    averagePrice: point.averagePrice,
    medianPrice: point.medianPrice,
    inventoryCount: point.inventoryCount,
    disclosedPriceCount: point.disclosedPriceCount,
  }));
}

/** 1か月でも平均・中央値のいずれかが存在すればチャートを表示する。 */
export function hasAnyPriceData(points: PriceTrendChartPoint[]): boolean {
  return points.some((point) => point.averagePrice !== null || point.medianPrice !== null);
}

/**
 * Y軸用の短縮表記。1万円未満は円、1億円未満は万円、それ以上は億円。
 * 例: 1,500,000 → "150万円" / 125,000,000 → "1.3億円"
 */
export function formatYenAxis(value: number): string {
  if (value >= 100_000_000) {
    return `${Number((value / 100_000_000).toFixed(1)).toLocaleString("ja-JP")}億円`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 10_000).toLocaleString("ja-JP")}万円`;
  }
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}
