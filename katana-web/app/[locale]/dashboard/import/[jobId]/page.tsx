import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getImportStatusDisplay } from "@/lib/dashboard/importStatus";
import { requireDashboardContext } from "../../_lib/requireDashboardContext";
import ImportPreviewTable from "../_components/ImportPreviewTable";
import ImportConfirmButton from "../_components/ImportConfirmButton";

export default async function ImportJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  // ジョブ・行の取得前に、DBの最新状態で認可する（shopIdはDB由来）
  const { shopId } = await requireDashboardContext();

  // 他店舗のジョブ（と紐づく行）はDB取得の時点で除外する
  const importJob = await prisma.importJob.findUnique({
    where: { id: jobId, shopId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });

  if (!importJob || importJob.shopId !== shopId) {
    notFound();
  }

  return (
    <main className="space-y-6 p-8">
      <div>
        <h1 className="text-3xl font-bold">取込プレビュー</h1>
        <p className="text-muted-foreground mt-1">{importJob.fileName}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">総行数</p>
          <p className="text-2xl font-bold">{importJob.totalRows}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">成功見込み</p>
          <p className="text-2xl font-bold text-green-600">{importJob.successRows}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">エラー</p>
          <p className="text-2xl font-bold text-red-600">{importJob.errorRows}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">状態</p>
          <p className="text-2xl font-bold">{getImportStatusDisplay(importJob.status).label}</p>
        </div>
      </div>

      {importJob.status === "PENDING" && (
        <ImportConfirmButton
          importJobId={importJob.id}
          disabled={importJob.successRows === 0}
        />
      )}

      <ImportPreviewTable rows={importJob.rows} />
    </main>
  );
}
