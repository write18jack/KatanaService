import { Package, Upload } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { auth } from "@/auth";
import { Link } from "@/i18n/navigation";
import { getDashboardMarketSummary, getOwnShopProductCounts } from "@/lib/dashboard/dashboardData";
import { formatCount, formatYen } from "@/lib/dashboard/format";
import { getMarketFilterMasters } from "@/lib/dashboard/marketFilterMasters";
import { resolveMarketFilters, type RawSearchParams } from "@/lib/dashboard/marketFilters";
import { getRolling30DaysPeriod } from "@/lib/dashboard/period";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MarketFilterBar } from "./_components/MarketFilterBar";
import { MarketMetricCard } from "./_components/MarketMetricCard";

type DashboardPageProps = {
  searchParams: Promise<RawSearchParams>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const t = await getTranslations("Dashboard");
  const session = await auth();

  if (!session?.user.shopId) {
    return <div>店舗情報がありません。</div>;
  }

  const shopId = session.user.shopId;

  const [masters, rawSearchParams, ownCounts] = await Promise.all([
    getMarketFilterMasters(),
    searchParams,
    getOwnShopProductCounts(shopId),
  ]);

  const { filters, invalidKeys } = resolveMarketFilters(rawSearchParams, masters);

  const { inventoryCount, average, medianPrice, soldCount } = await getDashboardMarketSummary(
    filters,
    getRolling30DaysPeriod(),
  );

  const disclosedRatio = `価格公開 ${average.disclosedPriceCount.toLocaleString("ja-JP")} / ${average.totalInventoryCount.toLocaleString("ja-JP")}件`;

  return (
    <main className="space-y-8 p-8">
      <div>
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground mt-1">市場動向と自店舗の商品状況</p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">市場サマリー</h2>

        <div className="space-y-3">
          <h3 className="text-muted-foreground text-sm font-medium">市場条件</h3>

          {invalidKeys.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                一部の検索条件が無効だったため、適用されませんでした。
              </AlertDescription>
            </Alert>
          )}

          <MarketFilterBar masters={masters} filters={filters} />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MarketMetricCard label="市場在庫数" value={formatCount(inventoryCount)} />
          <MarketMetricCard
            label="平均価格"
            value={formatYen(average.averagePrice)}
            description={disclosedRatio}
          />
          <MarketMetricCard label="中央値" value={formatYen(medianPrice)} description={disclosedRatio} />
          <MarketMetricCard label="直近30日SOLD" value={formatCount(soldCount)} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">自店の商品</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MarketMetricCard label="販売中" value={formatCount(ownCounts.activeCount)} />
          <MarketMetricCard label="SOLD" value={formatCount(ownCounts.soldCount)} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/dashboard/products">
              <Package className="mr-2 h-4 w-4" />
              商品一覧・編集
            </Link>
          </Button>

          <Button asChild variant="outline">
            <Link href="/dashboard/import">
              <Upload className="mr-2 h-4 w-4" />
              ファイル取り込み
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
