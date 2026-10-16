import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    importRow: { create: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    product: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    priceHistory: { create: vi.fn() },
    productHistory: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// マスター取得（DB）だけを差し替え、正規化などの純粋関数は本物を使う
vi.mock("@/lib/product-import/masterCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/product-import/masterCache")>();
  return { ...actual, loadMasterCaches: vi.fn() };
});

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadMasterCaches } from "@/lib/product-import/masterCache";
import { SESSION_A, SESSION_B, SHOP_A, SHOP_B, USER_A, USER_B } from "@/lib/testing/tenantFixtures";
import { validateImport } from "./validate";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedJobCreate = vi.mocked(prisma.importJob.create);

const HEADER = "product_code,name,category,sword_era,price";
const CSV = [HEADER, "TEST-001,テスト刀,刀,新刀,1000000", "TEST-002,,刀,新刀,"].join("\n");

function uploadForm(extra: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set("file", new File([CSV], "upload.csv", { type: "text/csv" }));
  for (const [key, value] of Object.entries(extra)) formData.set(key, value);
  return formData;
}

function expectNoProductWrites() {
  expect(prisma.product.create).not.toHaveBeenCalled();
  expect(prisma.product.update).not.toHaveBeenCalled();
  expect(prisma.product.upsert).not.toHaveBeenCalled();
  expect(prisma.priceHistory.create).not.toHaveBeenCalled();
  expect(prisma.productHistory.create).not.toHaveBeenCalled();
  expect(prisma.importJob.update).not.toHaveBeenCalled();
  expect(prisma.importRow.update).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadMasterCaches).mockResolvedValue({
    categories: new Map([["刀", "category-katana"]]),
    swordEras: new Map([["新刀", "sword-era-shinto"]]),
    makers: new Map(),
    appraisers: new Map(),
    grades: new Map(),
    periods: new Map(),
    provinces: new Map(),
    ranks: new Map(),
  });
  mockedJobCreate.mockResolvedValue({ id: "job-created" } as never);
});

describe("validateImport: 店舗間の認可", () => {
  it.each([
    ["店舗A", SESSION_A, SHOP_A.id, USER_A.id],
    ["店舗B", SESSION_B, SHOP_B.id, USER_B.id],
  ])("%sでアップロードすると、ImportJobはセッションの店舗・ユーザーで作成される", async (_label, session, shopId, userId) => {
    mockedAuth.mockResolvedValue(session);

    const result = await validateImport(uploadForm());

    expect(result).toEqual({ importJobId: "job-created" });
    expect(mockedJobCreate).toHaveBeenCalledTimes(1);
    const { data } = mockedJobCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({ shopId, executedById: userId, status: "PENDING", totalRows: 2, successRows: 1, errorRows: 1 });
  });

  it("ImportRowは作成するImportJobの入れ子としてのみ作られ、既存ジョブへの追加経路がない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    await validateImport(uploadForm());

    const { data } = mockedJobCreate.mock.calls[0][0] as { data: { rows: { create: Array<Record<string, unknown>> } } };
    expect(data.rows.create).toHaveLength(2);
    for (const row of data.rows.create) {
      // 行にimportJobIdやshopIdを外から指定しない（Prismaが親ジョブへ紐づける）
      expect(row).not.toHaveProperty("importJobId");
      expect(row).not.toHaveProperty("shopId");
    }
    expect(prisma.importRow.create).not.toHaveBeenCalled();
    expect(prisma.importRow.createMany).not.toHaveBeenCalled();
  });

  it("フォームに他店舗のshopId・executedById・importJobIdを含めても無視される", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    await validateImport(
      uploadForm({ shopId: SHOP_B.id, executedById: USER_B.id, importJobId: "job-hikouyoku-001", status: "COMPLETED" }),
    );

    const { data } = mockedJobCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.shopId).toBe(SHOP_A.id);
    expect(data.executedById).toBe(USER_A.id);
    expect(data.status).toBe("PENDING");
    expect(JSON.stringify(data)).not.toContain(SHOP_B.id);
    expect(JSON.stringify(data)).not.toContain(USER_B.id);
  });

  it("未ログインではファイルを処理せず、ImportJobを作成しない", async () => {
    mockedAuth.mockResolvedValue(null);

    const result = await validateImport(uploadForm());

    expect(result.error).toBeDefined();
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expect(mockedJobCreate).not.toHaveBeenCalled();
    expectNoProductWrites();
  });

  it("shopIdを持たないセッションでもImportJobを作成しない", async () => {
    mockedAuth.mockResolvedValue({ user: { id: USER_A.id }, expires: SESSION_A.expires } as never);

    const result = await validateImport(uploadForm());

    expect(result.error).toBeDefined();
    expect(mockedJobCreate).not.toHaveBeenCalled();
  });

  it("アップロード（検証）では商品・価格履歴・変更履歴を一切更新しない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    await validateImport(uploadForm());

    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expectNoProductWrites();
  });
});
