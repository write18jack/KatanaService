import { Package, Upload } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { auth } from "@/auth";
import { Link } from "@/i18n/navigation";
import { prisma } from "@/lib/prisma";
import { formatCount, formatYen } from "@/lib/dashboard/format";
import { getRolling30DaysPeriod } from "@/lib/dashboard/period";
import { getAveragePrice, getMarketInventoryCount, getMedianPrice } from "@/lib/market-analytics/currentMetrics";
import { getSoldCount } from "@/lib/market-analytics/soldMetrics";
import { Button } from "@/components/ui/button";
import { MarketMetricCard } from "./_components/MarketMetricCard";

export default async function DashboardPage() {
  const t = await getTranslations("Dashboard");
  const session = await auth();

  if (!session?.user.shopId) {
    return <div>店舗情報がありません。</div>;
  }

  const shopId = session.user.shopId;
  const { periodStart, periodEnd } = getRolling30DaysPeriod();

  const [inventoryCount, average, medianPrice, soldCount, ownActiveCount, ownSoldCount] = await Promise.all([
    getMarketInventoryCount({}),
    getAveragePrice({}),
    getMedianPrice({}),
    getSoldCount({}, periodStart, periodEnd),
    prisma.product.count({ where: { shopId, status: "ACTIVE" } }),
    prisma.product.count({ where: { shopId, status: "SOLD" } }),
  ]);

  const disclosedRatio = `価格公開 ${average.disclosedPriceCount.toLocaleString("ja-JP")} / ${average.totalInventoryCount.toLocaleString("ja-JP")}件`;

  return (
    <main className="space-y-8 p-8">
      <div>
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground mt-1">市場動向と自店舗の商品状況</p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">市場サマリー</h2>
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
          <MarketMetricCard label="販売中" value={formatCount(ownActiveCount)} />
          <MarketMetricCard label="SOLD" value={formatCount(ownSoldCount)} />
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
