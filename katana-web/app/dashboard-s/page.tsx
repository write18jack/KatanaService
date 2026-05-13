import ListingTable from "@/components/dashboard/ListingTable";

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
  const summary = await getSummary();

  return (
    <main className="p-8">
      <h1 className="mb-8 text-3xl font-bold">Katana Market Dashboard</h1>

      {/* Summary */}
      <div className="mb-10 grid grid-cols-4 gap-4">
        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">Total Listings</p>

          <p className="text-2xl font-bold">{summary.total}</p>
        </div>

        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">Average Price</p>

          <p className="text-2xl font-bold">
            ¥{summary.averagePrice?.toLocaleString() ?? "-"}
          </p>
        </div>

        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">Max Price</p>

          <p className="text-2xl font-bold">
            ¥{summary.maxPrice?.toLocaleString() ?? "-"}
          </p>
        </div>

        <div className="rounded-lg border p-4">
          <p className="text-sm text-gray-500">Min Price</p>

          <p className="text-2xl font-bold">
            ¥{summary.minPrice?.toLocaleString() ?? "-"}
          </p>
        </div>
      </div>

      <ListingTable />
    </main>
  );
}
