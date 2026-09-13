import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import ProductTable from "./_components/ProductTable";

export default async function ProductsPage() {
  const session = await auth();

  if (!session?.user.shopId) {
    return <div>店舗情報がありません。</div>;
  }

  const products = await prisma.product.findMany({
    where: {
      shopId: session.user.shopId,
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      maker: true,
      grade: true,
      period: true,
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
