import { prisma } from "@/lib/prisma";
import type { ImportRowCounts } from "./importStatus";

export const RECENT_IMPORT_LIMIT = 5;

export type RecentImportJob = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  /** アップロード（検証）時刻 */
  createdAt: Date;
  /** 確定処理の終了時刻。未確定のジョブはnull */
  completedAt: Date | null;
  rowCounts: ImportRowCounts | null;
};

/**
 * ログイン店舗の最近のImportJobを新しい順に最大5件取得する。
 * 自店専用の管理情報のため、必ずserver-sideのshopId（session由来）で限定し、
 * 市場フィルターは受け取らない。
 *
 * COMPLETEDのジョブに限り、実際に商品へ反映された行数をImportRowのstatus別件数から
 * DB側（groupBy 1回）で集計する。ImportRow本体は取得しない。
 */
export async function getRecentImportJobs(shopId: string): Promise<RecentImportJob[]> {
  const jobs = await prisma.importJob.findMany({
    where: { shopId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: RECENT_IMPORT_LIMIT,
    select: {
      id: true,
      fileName: true,
      status: true,
      totalRows: true,
      successRows: true,
      errorRows: true,
      createdAt: true,
      completedAt: true,
    },
  });

  const completedIds = jobs.filter((job) => job.status === "COMPLETED").map((job) => job.id);
  const countsByJob = new Map<string, ImportRowCounts>();

  if (completedIds.length > 0) {
    const grouped = await prisma.importRow.groupBy({
      by: ["importJobId", "status"],
      where: { importJobId: { in: completedIds }, importJob: { shopId } },
      _count: { _all: true },
    });

    for (const group of grouped) {
      const counts = countsByJob.get(group.importJobId) ?? { success: 0, error: 0, skipped: 0 };
      if (group.status === "SUCCESS") counts.success = group._count._all;
      if (group.status === "ERROR") counts.error = group._count._all;
      if (group.status === "SKIPPED") counts.skipped = group._count._all;
      countsByJob.set(group.importJobId, counts);
    }
  }

  return jobs.map((job) => ({
    ...job,
    rowCounts: countsByJob.get(job.id) ?? null,
  }));
}
