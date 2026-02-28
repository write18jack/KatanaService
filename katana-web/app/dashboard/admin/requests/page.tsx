import prisma from "@/lib/prisma";
import { columns } from "./columns";
import { DataTable } from "@/app/dashboard/user/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default async function AdminRequestsPage() {
  // すべての申請を取得
  const allRequests = await prisma.katanaRequest.findMany({
    include: {
      applicant: true,
      targetKatana: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // ステータスごとに振り分け
  const pendingRequests = allRequests.filter((r) => r.status === "PENDING");
  const historyRequests = allRequests.filter((r) => r.status !== "PENDING");

  return (
    <div className="container mx-auto py-10">
      <h1 className="mb-6 text-2xl font-bold">申請管理</h1>

      <Tabs defaultValue="pending" className="w-full">
        <TabsList>
          <TabsTrigger value="pending">
            未承認 ({pendingRequests.length})
          </TabsTrigger>
          <TabsTrigger value="history">履歴 (承認済・却下済)</TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          <DataTable columns={columns} data={pendingRequests} />
        </TabsContent>

        <TabsContent value="history">
          <DataTable columns={columns} data={historyRequests} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
