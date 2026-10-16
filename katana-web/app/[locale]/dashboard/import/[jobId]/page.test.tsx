import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOT_FOUND = vi.hoisted(() => new Error("NEXT_NOT_FOUND"));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw NOT_FOUND;
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    importRow: { findMany: vi.fn(), update: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { JOB_A, JOB_B, MISSING_ID, ROW_A, ROW_B, SESSION_A, SESSION_B, USER_A } from "@/lib/testing/tenantFixtures";
import ImportJobPage from "./page";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedFindUnique = vi.mocked(prisma.importJob.findUnique);

const SECRETS = {
  [JOB_A.id]: { productCode: "AVOCADO-SECRET-CODE", message: "アボガド店の行エラー", raw: "アボガド店の原本データ" },
  [JOB_B.id]: { productCode: "HIKOUYOKU-SECRET-CODE", message: "日光浴の行エラー", raw: "日光浴の原本データ" },
};

function jobRecord(job: typeof JOB_A | typeof JOB_B) {
  const row = job.id === JOB_A.id ? ROW_A : ROW_B;
  const secret = SECRETS[job.id];
  return {
    id: job.id,
    shopId: job.shopId,
    fileName: job.fileName,
    status: "PENDING",
    totalRows: 1,
    successRows: 0,
    errorRows: 1,
    executedById: USER_A.id,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-10-12T00:00:00Z"),
    rows: [
      {
        id: row.id,
        importJobId: job.id,
        rowNumber: 2,
        productCode: secret.productCode,
        rawData: { name: secret.raw },
        status: "ERROR",
        message: secret.message,
        createdAt: new Date("2026-10-12T00:00:00Z"),
      },
    ],
  } as never;
}

function render(jobId: string) {
  return ImportJobPage({ params: Promise.resolve({ jobId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ImportJob詳細ページ: 店舗間の認可", () => {
  it("ケースA: 店舗Aのユーザーは店舗Aのジョブを表示できる", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(jobRecord(JOB_A));

    const html = renderToStaticMarkup(await render(JOB_A.id));

    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { id: JOB_A.id },
      include: { rows: { orderBy: { rowNumber: "asc" } } },
    });
    expect(html).toContain(JOB_A.fileName);
    expect(html).toContain(SECRETS[JOB_A.id].productCode);
    expect(html).toContain(SECRETS[JOB_A.id].message);
  });

  it("rawData（取り込み原本）は自店のジョブでも画面に描画しない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(jobRecord(JOB_A));

    const html = renderToStaticMarkup(await render(JOB_A.id));

    expect(html).not.toContain(SECRETS[JOB_A.id].raw);
  });

  it.each([
    ["ケースB: 店舗A → 店舗BのジョブID", SESSION_A, JOB_B],
    ["ケースC: 店舗B → 店舗AのジョブID", SESSION_B, JOB_A],
  ])("%s は notFound() になり、何も描画しない", async (_label, session, otherJob) => {
    mockedAuth.mockResolvedValue(session);
    mockedFindUnique.mockResolvedValue(jobRecord(otherJob));

    await expect(render(otherJob.id)).rejects.toBe(NOT_FOUND);
  });

  it("ケースE: 存在しないジョブIDは notFound() になる", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(null);

    await expect(render(MISSING_ID)).rejects.toBe(NOT_FOUND);
  });

  it("他店舗のジョブと存在しないジョブで同じ応答になる（存在を推測できない）", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    mockedFindUnique.mockResolvedValueOnce(jobRecord(JOB_B));
    const otherShop = await render(JOB_B.id).catch((error: unknown) => error);
    mockedFindUnique.mockResolvedValueOnce(null);
    const missing = await render(MISSING_ID).catch((error: unknown) => error);

    expect(otherShop).toBe(NOT_FOUND);
    expect(missing).toBe(otherShop);
  });

  it("ケースD: 未ログインではジョブを検索せず、ファイル名や行を描画しない", async () => {
    // ログイン画面へのリダイレクトはproxy.tsの責務（proxy.test.tsで検証）。ページ自体は何も取得しない。
    mockedAuth.mockResolvedValue(null);

    const html = renderToStaticMarkup(await render(JOB_A.id));

    expect(mockedFindUnique).not.toHaveBeenCalled();
    expect(html).not.toContain(JOB_A.fileName);
    expect(html).not.toContain(SECRETS[JOB_A.id].productCode);
  });

  it("このページはジョブや行を更新しない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValue(jobRecord(JOB_A));

    await render(JOB_A.id);

    expect(prisma.importJob.update).not.toHaveBeenCalled();
    expect(prisma.importRow.update).not.toHaveBeenCalled();
  });
});
