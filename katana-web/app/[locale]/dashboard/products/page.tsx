import { prisma } from "@/lib/prisma";
import { requireDashboardContext } from "../_lib/requireDashboardContext";
import ProductTable from "./_components/ProductTable";

export default async function ProductsPage() {
  // 商品の取得前に、DBの最新状態で認可する（shopIdはDB由来）
  const { shopId } = await requireDashboardContext();

  const products = await prisma.product.findMany({
    where: {
      shopId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      productCode: true,
      title: true,
      price: true,
      status: true,
    },
  });

  return (
    <main className="space-y-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">商品一覧</h1>
      </div>

      <ProductTable products={products} />
    </main>
  );
}
