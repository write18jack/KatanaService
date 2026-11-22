import { beforeEach, describe, expect, it, vi } from "vitest";

// recentImports.integration.test.ts は実DBの統合テスト。こちらはPrismaをモックし、DBなしで問い合わせ条件を検証する。
vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { findMany: vi.fn() },
    importRow: { groupBy: vi.fn(), findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { JOB_A, JOB_B, SHOP_A, SHOP_B } from "@/lib/testing/tenantFixtures";
import { getRecentImportJobs } from "./recentImports";

const mockedFindMany = vi.mocked(prisma.importJob.findMany);
const mockedGroupBy = vi.mocked(prisma.importRow.groupBy);

/** 簡易DB: 両店舗のジョブ。where.shopId が無ければ全件を返し、絞り込み漏れを検出できる */
const JOBS = [
  { ...JOB_A, status: "COMPLETED", totalRows: 1, successRows: 1, errorRows: 0, createdAt: new Date("2026-10-12T00:00:00Z"), completedAt: new Date("2026-10-12T00:01:00Z") },
  { ...JOB_B, status: "COMPLETED", totalRows: 1, successRows: 1, errorRows: 0, createdAt: new Date("2026-10-13T00:00:00Z"), completedAt: new Date("2026-10-13T00:01:00Z") },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindMany.mockImplementation((async (args: { where?: { shopId?: string } }) =>
    JOBS.filter((job) => !args.where?.shopId || job.shopId === args.where.shopId).map((job) => {
      // selectにshopIdが無いため、Prismaの戻り値と同様にshopIdを含めない
      const rest: Record<string, unknown> = { ...job };
      delete rest.shopId;
      return rest;
    })) as never);
  mockedGroupBy.mockImplementation((async (args: { where: { importJobId: { in: string[] } } }) =>
    args.where.importJobId.in.map((importJobId) => ({ importJobId, status: "SUCCESS", _count: { _all: 1 } }))) as never);
});

describe("getRecentImportJobs: 店舗分離（モック）", () => {
  it.each([
    ["店舗A", SHOP_A.id, JOB_A, JOB_B],
    ["店舗B", SHOP_B.id, JOB_B, JOB_A],
  ])("%sの履歴には自店のジョブだけが含まれ、他店のファイル名は含まれない", async (_label, shopId, own, other) => {
    const jobs = await getRecentImportJobs(shopId);

    expect(mockedFindMany.mock.calls[0][0]).toMatchObject({ where: { shopId }, take: 5 });
    expect(jobs.map((job) => job.id)).toEqual([own.id]);
    expect(JSON.stringify(jobs)).not.toContain(other.fileName);
  });

  it("ImportRowの集計は自店の完了ジョブに限定し、さらにshopIdでも絞る", async () => {
    await getRecentImportJobs(SHOP_A.id);

    expect(mockedGroupBy).toHaveBeenCalledTimes(1);
    expect(mockedGroupBy.mock.calls[0][0]).toMatchObject({
      where: { importJobId: { in: [JOB_A.id] }, importJob: { shopId: SHOP_A.id } },
    });
    expect(prisma.importRow.findMany).not.toHaveBeenCalled();
  });

  it("返却値とselectにshopIdを含めない", async () => {
    const jobs = await getRecentImportJobs(SHOP_A.id);

    expect(jobs[0]).not.toHaveProperty("shopId");
    expect((mockedFindMany.mock.calls[0][0] as { select: Record<string, boolean> }).select).not.toHaveProperty("shopId");
  });

  it("取得条件はshopIdだけで、市場フィルター等を受け取らない", () => {
    expect(getRecentImportJobs.length).toBe(1);
  });
});
