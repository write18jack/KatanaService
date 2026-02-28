import prisma from "@/lib/prisma";
import { columns, Katana } from "./columns";
import { DataTable } from "./data-table";
import { KatanaNewRequest } from "@/components/katana/KatanaNewRequest";

export default async function UserDashboard() {
  // 公開されている刀剣一覧を取得
  const data = await prisma.katana.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });

  // あなたが定義した厳密な型「Katana[]」にキャストする
  const katanas = data as unknown as Katana[];

  return (
    <div className="container mx-auto py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">刀剣在庫管理表</h1>
        {/* 申請フォーム（Dialog内蔵ボタン）を配置 */}
        <KatanaNewRequest />
      </div>

      <DataTable columns={columns} data={katanas} />
    </div>
  );
}
