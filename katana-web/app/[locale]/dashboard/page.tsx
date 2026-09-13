import { auth } from "@/auth";
import { getTranslations } from "next-intl/server";

export default async function DashboardPage() {
  const t = await getTranslations("Dashboard");
  const session = await auth();

  return (
    <main className="p-8">
      <h1 className="mb-8 text-3xl font-bold">{t("title")}</h1>

      <pre>{JSON.stringify(session, null, 2)}</pre>

      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border p-6">
          <p className="text-gray-500">商品数</p>
          <p className="text-3xl font-bold">0</p>
        </div>

        <div className="rounded-lg border p-6">
          <p className="text-gray-500">販売中</p>
          <p className="text-3xl font-bold">0</p>
        </div>

        <div className="rounded-lg border p-6">
          <p className="text-gray-500">売約済</p>
          <p className="text-3xl font-bold">0</p>
        </div>

        <div className="rounded-lg border p-6">
          <p className="text-gray-500">CSV取込回数</p>
          <p className="text-3xl font-bold">0</p>
        </div>
      </div>
    </main>
  );
}
