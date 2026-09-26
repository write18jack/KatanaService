import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import ImportPreviewTable from "../_components/ImportPreviewTable";
import ImportConfirmButton from "../_components/ImportConfirmButton";

export default async function ImportJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const session = await auth();

  if (!session?.user?.shopId) {
    return <div>店舗情報がありません。</div>;
  }

  const importJob = await prisma.importJob.findUnique({
    where: { id: jobId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });

  if (!importJob || importJob.shopId !== session.user.shopId) {
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
          <p className="text-2xl font-bold">{importJob.status}</p>
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
