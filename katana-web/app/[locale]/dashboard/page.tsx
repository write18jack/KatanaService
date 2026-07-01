import ListingTable from "@/app/[locale]/dashboard/_components/ListingTable";
import { getTranslations } from "next-intl/server";

type MarketSummary = {
  total: number;
  averagePrice: number | null;
  maxPrice: number | null;
  minPrice: number | null;
};

async function getSummary(): Promise<MarketSummary> {
  const res = await fetch("http://localhost:3000/api/market/summary", {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error("Failed to fetch summary");
  }

  return res.json();
}

export default async function DashboardPage() {
  const t = await getTranslations("Dashboard");
  const summary = await getSummary();

  return (
    <main className="p-8">
      <h1 className="mb-8 text-3xl font-bold">{t("title")}</h1>

      {/* Summary */}
      <div className="mb-10 grid grid-cols-4 gap-4">
        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">{t("summary.totalListings")}</p>

          <p className="text-2xl font-bold">{summary.total}</p>
        </div>

        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">{t("summary.averagePrice")}</p>

          <p className="text-2xl font-bold">
            ¥{summary.averagePrice?.toLocaleString() ?? "-"}
          </p>
        </div>

        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">{t("summary.maxPrice")}</p>

          <p className="text-2xl font-bold">
            ¥{summary.maxPrice?.toLocaleString() ?? "-"}
          </p>
        </div>

        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">{t("summary.minPrice")}</p>

          <p className="text-2xl font-bold">
            ¥{summary.minPrice?.toLocaleString() ?? "-"}
          </p>
        </div>
      </div>

      <ListingTable />
    </main>
  );
}
