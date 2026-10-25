import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// 認可はDB由来のコンテキストで行う。Actionのテストでは結果をモックし、DB照合そのものは lib/auth/context.test.ts で検証する
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getAuthContext: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
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

import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { getAuthContext } from "@/lib/auth/context";
import { prisma } from "@/lib/prisma";
import { loadMasterCaches } from "@/lib/product-import/masterCache";
import { SESSION_A, SESSION_B, SHOP_A, SHOP_B, USER_A, USER_B } from "@/lib/testing/tenantFixtures";
import { validateImport } from "./validate";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedAuthContext = vi.mocked(getAuthContext);
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique);
const actualAuthContext = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");

type SessionLike = { user: { id: string; shopId: string; role: string } };

/** DB照合に成功した認可コンテキスト（DB上の値がセッションと一致している場合） */
function contextOf(session: SessionLike) {
  return {
    ok: true as const,
    context: { userId: session.user.id, shopId: session.user.shopId, role: session.user.role as UserRole },
  };
}

function signInAs(session: SessionLike) {
  mockedAuthContext.mockResolvedValue(contextOf(session));
}

function denyAuth(reason: "UNAUTHENTICATED" | "USER_NOT_FOUND" | "SHOP_INACTIVE") {
  mockedAuthContext.mockResolvedValue({ ok: false, reason });
}

/** 実際の認可ヘルパーを通す（auth() が返すJWTと、DB上のUserだけをモックする） */
function useRealAuthContext(jwt: unknown, dbUser: unknown) {
  mockedAuthContext.mockImplementation(actualAuthContext.getAuthContext);
  mockedAuth.mockResolvedValue(jwt);
  mockedUserFindUnique.mockResolvedValue(dbUser as never);
}
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
  mockedAuth.mockReset();
  mockedAuthContext.mockReset();
  mockedUserFindUnique.mockReset();
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
    signInAs(session);

    const result = await validateImport(uploadForm());

    expect(result).toEqual({ importJobId: "job-created" });
    expect(mockedJobCreate).toHaveBeenCalledTimes(1);
    const { data } = mockedJobCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({ shopId, executedById: userId, status: "PENDING", totalRows: 2, successRows: 1, errorRows: 1 });
  });

  it("ImportRowは作成するImportJobの入れ子としてのみ作られ、既存ジョブへの追加経路がない", async () => {
    signInAs(SESSION_A);

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
    signInAs(SESSION_A);

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
    denyAuth("UNAUTHENTICATED");

    const result = await validateImport(uploadForm());

    expect(result.error).toBeDefined();
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expect(mockedJobCreate).not.toHaveBeenCalled();
    expectNoProductWrites();
  });

  it.each(["USER_NOT_FOUND", "SHOP_INACTIVE"] as const)("DB照合が %s ならファイルを処理せず、ImportJobを作成しない", async (reason) => {
    denyAuth(reason);

    const result = await validateImport(uploadForm());

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expect(mockedJobCreate).not.toHaveBeenCalled();
    expectNoProductWrites();
  });

  it("アップロード（検証）では商品・価格履歴・変更履歴を一切更新しない", async () => {
    signInAs(SESSION_A);

    await validateImport(uploadForm());

    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expectNoProductWrites();
  });
});

describe("validateImport: DB由来の認可コンテキスト（F-01-C）", () => {
  function createdJobData() {
    return (mockedJobCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
  }

  it("DB上の所属が店舗Bなら、ImportJobは店舗Bで作成される（JWTの店舗Aを使わない）", async () => {
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "STORE" } });

    const result = await validateImport(uploadForm());

    expect(result).toEqual({ importJobId: "job-created" });
    expect(createdJobData()).toMatchObject({ shopId: SHOP_B.id, executedById: USER_A.id, status: "PENDING" });
  });

  it("実際の認可ヘルパー経由: JWTは店舗A・ADMIN、DBは店舗B・STOREなら店舗Bで作成される", async () => {
    useRealAuthContext(SESSION_A, { id: USER_A.id, shopId: SHOP_B.id, role: "STORE", shop: { isActive: true } });

    await validateImport(uploadForm());

    expect(mockedUserFindUnique.mock.calls[0][0]).toMatchObject({ where: { id: USER_A.id } });
    expect(createdJobData()).toMatchObject({ shopId: SHOP_B.id, executedById: USER_A.id });
    expect(JSON.stringify(createdJobData())).not.toContain(SHOP_A.id);
  });

  it.each([
    ["店舗が無効", { id: USER_A.id, shopId: SHOP_A.id, role: "ADMIN", shop: { isActive: false } }],
    ["ユーザーが削除済み", null],
  ])("実際の認可ヘルパー経由: DB上で%sなら、JWTが有効でも拒否し、ImportJobを作成しない", async (_label, dbUser) => {
    useRealAuthContext(SESSION_A, dbUser);

    const result = await validateImport(uploadForm());

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expect(mockedJobCreate).not.toHaveBeenCalled();
    expectNoProductWrites();
  });

  it("getAuthContext() が例外（DB障害など）なら伝播し、ImportJobを作成しない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedAuthContext.mockRejectedValue(new Error("db down"));

    await expect(validateImport(uploadForm())).rejects.toThrow("db down");
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expect(mockedJobCreate).not.toHaveBeenCalled();
    expectNoProductWrites();
  });

  it("入口で getAuthContext() を1回だけ呼び、auth() を直接呼ばない", async () => {
    signInAs(SESSION_A);

    await validateImport(uploadForm());

    expect(mockedAuthContext).toHaveBeenCalledTimes(1);
    expect(mockedAuth).not.toHaveBeenCalled();
  });
});
