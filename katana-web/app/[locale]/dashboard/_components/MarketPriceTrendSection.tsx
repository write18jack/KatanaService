import { getDashboardPriceTrend } from "@/lib/dashboard/dashboardData";
import { formatCount, formatYen } from "@/lib/dashboard/format";
import { hasAnyPriceData } from "@/lib/dashboard/priceTrendChart";
import type { MarketFilters } from "@/lib/market-analytics/types";
import { Card, CardContent } from "@/components/ui/card";
import { MarketPriceTrendChart } from "./MarketPriceTrendChart";

type MarketPriceTrendSectionProps = {
  /** Dashboard pageで検証済みの、4 KPIと同一のMarketFilters */
  filters: MarketFilters;
};

/**
 * 相場推移（過去12か月・月末時点）。
 * 非同期のServer Componentとして自身で月末Snapshotを取得するため、
 * page側のSuspense境界内でfallback（MarketPriceTrendSkeleton）が実際に表示される。
 */
export async function MarketPriceTrendSection({ filters }: MarketPriceTrendSectionProps) {
  const data = await getDashboardPriceTrend(filters);

  if (!hasAnyPriceData(data)) {
    return (
      <Card>
        <CardContent className="flex h-72 flex-col items-center justify-center gap-1 text-center">
          <p className="font-medium">表示できる価格データがありません。</p>
          <p className="text-muted-foreground text-sm">
            この条件では、過去12か月の月末時点に価格が公開されている商品の記録がありません。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <MarketPriceTrendChart data={data} />

        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer">表で見る</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-right tabular-nums">
              <thead className="text-muted-foreground text-xs">
                <tr className="border-b">
                  <th scope="col" className="py-1.5 text-left font-normal">年月</th>
                  <th scope="col" className="py-1.5 pl-4 font-normal">平均価格</th>
                  <th scope="col" className="py-1.5 pl-4 font-normal">中央値</th>
                  <th scope="col" className="py-1.5 pl-4 font-normal">在庫数</th>
                  <th scope="col" className="py-1.5 pl-4 font-normal">価格公開</th>
                </tr>
              </thead>
              <tbody>
                {data.map((point) => (
                  <tr key={point.label} className="border-b last:border-0">
                    <th scope="row" className="py-1.5 text-left font-normal">{point.label}</th>
                    <td className="py-1.5 pl-4">{formatYen(point.averagePrice)}</td>
                    <td className="py-1.5 pl-4">{formatYen(point.medianPrice)}</td>
                    <td className="py-1.5 pl-4">{formatCount(point.inventoryCount)}</td>
                    <td className="py-1.5 pl-4">{point.disclosedPriceCount.toLocaleString("ja-JP")}件</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

/** チャートと同じ高さを確保し、読み込み中にレイアウトが跳ねないようにするfallback。 */
export function MarketPriceTrendSkeleton() {
  return (
    <Card>
      <CardContent>
        <div
          className="bg-muted flex h-72 animate-pulse items-center justify-center rounded-md"
          role="status"
          aria-label="相場推移を読み込んでいます"
        >
          <span className="text-muted-foreground text-sm">相場推移を読み込んでいます…</span>
        </div>
      </CardContent>
    </Card>
  );
}
