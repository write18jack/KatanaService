import { randomUUID } from "node:crypto";
import type { ImportRowStatus, ImportStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getRecentImportJobs } from "./recentImports";

/**
 * 取り込み履歴取得の統合テスト（ローカルdocker Postgres）。
 * 一意な名前のテスト用Shop/Userを作成し、afterAllで作成したデータだけを削除する。
 */
describe("getRecentImportJobs (integration, real Postgres)", () => {
  const suffix = randomUUID();
  const shopIds: string[] = [];
  const userIds: string[] = [];
  const jobIds: string[] = [];

  let ownShopId: string;
  let otherShopId: string;
  let emptyShopId: string;
  let fiveJobShopId: string;
  const userByShop = new Map<string, string>();

  async function createShop(label: string): Promise<string> {
    // 市場分析に影響しないよう isActive=false で作成する
    const shop = await prisma.shop.create({ data: { name: `テスト店舗(${label}) ${suffix}`, isActive: false } });
    const user = await prisma.user.create({
      data: {
        name: `テストユーザー(${label})`,
        email: `test-${label}-${suffix}@example.invalid`,
        password: "not-a-real-hash",
        shopId: shop.id,
      },
    });
    shopIds.push(shop.id);
    userIds.push(user.id);
    userByShop.set(shop.id, user.id);
    return shop.id;
  }

  async function createJob(
    shopId: string,
    data: {
      fileName: string;
      createdAt: Date;
      id?: string;
      status?: ImportStatus;
      totalRows?: number;
      successRows?: number;
      errorRows?: number;
      completedAt?: Date | null;
      rows?: ImportRowStatus[];
    },
  ): Promise<string> {
    const { rows = [], ...jobData } = data;
    const job = await prisma.importJob.create({
      data: {
        ...jobData,
        shopId,
        executedById: userByShop.get(shopId)!,
        rows: { create: rows.map((status, index) => ({ rowNumber: index + 2, status })) },
      },
    });
    jobIds.push(job.id);
    return job.id;
  }

  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    [ownShopId, otherShopId, emptyShopId, fiveJobShopId] = await Promise.all([
      createShop("own"),
      createShop("other"),
      createShop("empty"),
      createShop("five"),
    ]);

    // 自店: 7件（うち2件は同一日時）
    await createJob(ownShopId, { fileName: "own-1.xlsx", createdAt: at("2026-10-01T01:00:00Z") });
    await createJob(ownShopId, { fileName: "own-2.xlsx", createdAt: at("2026-10-02T01:00:00Z") });
    await createJob(ownShopId, {
      fileName: "own-3-failed.csv",
      createdAt: at("2026-10-03T01:00:00Z"),
      status: "FAILED",
      totalRows: 12,
      successRows: 10,
      errorRows: 2,
      completedAt: at("2026-10-03T01:05:00Z"),
      rows: ["SUCCESS", "ERROR"],
    });
    await createJob(ownShopId, {
      fileName: "own-4-completed.xlsx",
      createdAt: at("2026-10-04T01:00:00Z"),
      status: "COMPLETED",
      totalRows: 6,
      successRows: 4,
      errorRows: 1,
      completedAt: at("2026-10-04T01:02:00Z"),
      // 検証時はSUCCESS 4行だったが、確定時の再検証で1行がERRORになった状態
      rows: ["SUCCESS", "SUCCESS", "SUCCESS", "ERROR", "ERROR", "SKIPPED"],
    });
    await createJob(ownShopId, {
      fileName: "own-5-completed-no-rows.xlsx",
      createdAt: at("2026-10-05T01:00:00Z"),
      status: "COMPLETED",
      totalRows: 3,
      successRows: 3,
    });
    await createJob(ownShopId, {
      id: "00000000-0000-4000-8000-00000000000a",
      fileName: "own-6-same-time-a.xlsx",
      createdAt: at("2026-10-06T01:00:00Z"),
    });
    await createJob(ownShopId, {
      id: "00000000-0000-4000-8000-00000000000b",
      fileName: "own-6-same-time-b.xlsx",
      createdAt: at("2026-10-06T01:00:00Z"),
    });

    // 他店: 自店より新しい日時のジョブ（混入すれば先頭に来る）
    await createJob(otherShopId, {
      fileName: "other-shop-secret.xlsx",
      createdAt: at("2026-10-09T01:00:00Z"),
      status: "COMPLETED",
      totalRows: 2,
      successRows: 2,
      rows: ["SUCCESS", "SUCCESS"],
    });

    for (let day = 1; day <= 5; day++) {
      await createJob(fiveJobShopId, { fileName: `five-${day}.csv`, createdAt: at(`2026-09-0${day}T01:00:00Z`) });
    }
  });

  afterAll(async () => {
    await prisma.importRow.deleteMany({ where: { importJobId: { in: jobIds } } });
    await prisma.importJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  });

  it("6件以上あっても最大5件を新しい順に返す", async () => {
    const jobs = await getRecentImportJobs(ownShopId);
    expect(jobs.map((job) => job.fileName)).toEqual([
      "own-6-same-time-b.xlsx",
      "own-6-same-time-a.xlsx",
      "own-5-completed-no-rows.xlsx",
      "own-4-completed.xlsx",
      "own-3-failed.csv",
    ]);
  });

  it("同一日時のジョブはid降順で安定して並ぶ", async () => {
    const first = await getRecentImportJobs(ownShopId);
    const second = await getRecentImportJobs(ownShopId);
    expect(first.slice(0, 2).map((job) => job.id)).toEqual([
      "00000000-0000-4000-8000-00000000000b",
      "00000000-0000-4000-8000-00000000000a",
    ]);
    expect(second.map((job) => job.id)).toEqual(first.map((job) => job.id));
  });

  it("他店舗のImportJob（ファイル名・結果）を含めない", async () => {
    const jobs = await getRecentImportJobs(ownShopId);
    expect(jobs.some((job) => job.fileName === "other-shop-secret.xlsx")).toBe(false);

    const otherJobs = await getRecentImportJobs(otherShopId);
    expect(otherJobs.map((job) => job.fileName)).toEqual(["other-shop-secret.xlsx"]);
  });

  it("ImportJobが0件の店舗は空配列を返す", async () => {
    expect(await getRecentImportJobs(emptyShopId)).toEqual([]);
  });

  it("ImportJobがちょうど5件の店舗は5件すべて返す", async () => {
    const jobs = await getRecentImportJobs(fiveJobShopId);
    expect(jobs.map((job) => job.fileName)).toEqual([
      "five-5.csv", "five-4.csv", "five-3.csv", "five-2.csv", "five-1.csv",
    ]);
  });

  it("COMPLETEDのジョブはImportRowをstatus別にDB側で集計する", async () => {
    const jobs = await getRecentImportJobs(ownShopId);
    const completed = jobs.find((job) => job.fileName === "own-4-completed.xlsx")!;

    expect(completed.rowCounts).toEqual({ success: 3, error: 2, skipped: 1 });
    // 検証時の値はそのまま保持され、反映行数（3）とは別の数値である
    expect(completed.successRows).toBe(4);
    expect(completed.completedAt?.toISOString()).toBe("2026-10-04T01:02:00.000Z");
  });

  it("ImportRowの記録が無いCOMPLETEDジョブは0件ではなくnull（未記録）", async () => {
    const jobs = await getRecentImportJobs(ownShopId);
    expect(jobs.find((job) => job.fileName === "own-5-completed-no-rows.xlsx")!.rowCounts).toBeNull();
  });

  it("COMPLETED以外のジョブはImportRowを集計しない（反映行数を推測しない）", async () => {
    const jobs = await getRecentImportJobs(ownShopId);
    const failed = jobs.find((job) => job.fileName === "own-3-failed.csv")!;
    expect(failed.rowCounts).toBeNull();
    expect(failed).toMatchObject({ status: "FAILED", totalRows: 12, successRows: 10, errorRows: 2 });
  });

  it("表示に必要なfieldのみ返し、shopId・実行ユーザー・ImportRow本体を含めない", async () => {
    const [job] = await getRecentImportJobs(ownShopId);
    expect(Object.keys(job).sort()).toEqual(
      ["completedAt", "createdAt", "errorRows", "fileName", "id", "rowCounts", "status", "successRows", "totalRows"].sort(),
    );
  });

  it("引数はshopIdのみで、MarketFilters等を受け取らない", () => {
    expect(getRecentImportJobs.length).toBe(1);
  });
});
