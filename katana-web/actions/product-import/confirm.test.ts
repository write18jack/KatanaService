import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// トランザクション内（tx）とトランザクション外（prisma）の書き込みを分けて観測する
const tx = vi.hoisted(() => ({
  importJob: { update: vi.fn() },
  importRow: { update: vi.fn() },
  product: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  priceHistory: { create: vi.fn() },
  productHistory: { create: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    importRow: { findMany: vi.fn(), update: vi.fn() },
    product: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    priceHistory: { create: vi.fn() },
    productHistory: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/product-import/masterCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/product-import/masterCache")>();
  return { ...actual, loadMasterCaches: vi.fn() };
});

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadMasterCaches } from "@/lib/product-import/masterCache";
import {
  JOB_A,
  JOB_B,
  MISSING_ID,
  PRODUCT_A,
  PRODUCT_B,
  ROW_A,
  ROW_B,
  SESSION_A,
  SESSION_B,
  SHOP_A,
  SHOP_B,
  USER_A,
} from "@/lib/testing/tenantFixtures";
import { confirmImport } from "./confirm";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedJobFindUnique = vi.mocked(prisma.importJob.findUnique);

const RAW_ROW = { product_code: "TEST-001", name: "テスト刀", category: "刀", sword_era: "新刀", price: "1500000" };

function jobRecord(job: typeof JOB_A | typeof JOB_B, status = "PENDING") {
  const row = job.id === JOB_A.id ? ROW_A : ROW_B;
  return {
    id: job.id,
    shopId: job.shopId,
    fileName: job.fileName,
    status,
    rows: [{ id: row.id, importJobId: job.id, rowNumber: 2, status: "SUCCESS", rawData: RAW_ROW, message: null }],
  } as never;
}

function existingProduct(product: typeof PRODUCT_A | typeof PRODUCT_B, price: number) {
  return {
    id: product.id,
    shopId: product.shopId,
    productCode: product.productCode,
    title: "既存の刀",
    categoryId: "category-katana",
    makerId: null,
    appraiserId: null,
    gradeId: null,
    rankId: null,
    periodId: null,
    provinceId: null,
    swordEraId: "sword-era-shinto",
    price,
    bladeLength: null,
    curvature: null,
  };
}

/** (shopId, productCode) をキーにした簡易DB。tx.product.findUnique はこれだけを見る */
function seedProducts(products: Array<ReturnType<typeof existingProduct>>) {
  const byKey = new Map(products.map((p) => [`${p.shopId}:${p.productCode}`, p]));
  tx.product.findUnique.mockImplementation(async (args: { where: { shopId_productCode?: { shopId: string; productCode: string } } }) => {
    const key = args.where.shopId_productCode;
    return key ? (byKey.get(`${key.shopId}:${key.productCode}`) ?? null) : null;
  });
}

function allWriteMocks() {
  return [
    prisma.importJob.update,
    prisma.importRow.update,
    prisma.product.create,
    prisma.product.update,
    prisma.priceHistory.create,
    prisma.productHistory.create,
    tx.importJob.update,
    tx.importRow.update,
    tx.product.create,
    tx.product.update,
    tx.priceHistory.create,
    tx.productHistory.create,
  ];
}

function expectNoWrites() {
  expect(prisma.$transaction).not.toHaveBeenCalled();
  for (const mock of allWriteMocks()) expect(mock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.product.findUnique.mockReset();
  vi.mocked(prisma.$transaction).mockImplementation((async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) as never);
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
  tx.product.create.mockImplementation(async (args: { data: { shopId: string } }) => ({ id: `created-in-${args.data.shopId}` }));
  seedProducts([]);
});

describe("confirmImport: 店舗間の認可", () => {
  it("ケースA: 店舗Aのユーザーは店舗AのPENDINGジョブを確定でき、書き込みはすべて店舗Aに限られる", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedJobFindUnique.mockResolvedValue(jobRecord(JOB_A));

    const result = await confirmImport(JOB_A.id);

    expect(result.success).toBeDefined();
    expect(tx.importJob.update).toHaveBeenCalledTimes(2);
    for (const [args] of tx.importJob.update.mock.calls) expect(args.where).toEqual({ id: JOB_A.id });
    expect(tx.importJob.update.mock.calls.at(-1)?.[0].data.status).toBe("COMPLETED");
    expect(tx.product.findUnique).toHaveBeenCalledWith({
      where: { shopId_productCode: { shopId: SHOP_A.id, productCode: "TEST-001" } },
    });
    expect(tx.product.create.mock.calls[0][0].data).toMatchObject({
      shopId: SHOP_A.id,
      productCode: "TEST-001",
      createdById: USER_A.id,
      status: "ACTIVE",
    });
    expect(tx.priceHistory.create.mock.calls[0][0].data).toMatchObject({ productId: `created-in-${SHOP_A.id}`, newPrice: 1500000 });
    expect(tx.productHistory.create.mock.calls[0][0].data).toMatchObject({
      productId: `created-in-${SHOP_A.id}`,
      action: "IMPORT",
      changedById: USER_A.id,
    });
    expect(JSON.stringify(allWriteMocks().map((m) => vi.mocked(m).mock.calls))).not.toContain(SHOP_B.id);
  });

  it.each([
    ["ケースB: 店舗A → 店舗BのジョブID", SESSION_A, JOB_B],
    ["ケースC: 店舗B → 店舗AのジョブID", SESSION_B, JOB_A],
  ])("%s は拒否され、ジョブ・商品・履歴・行のいずれも更新されない", async (_label, session, otherJob) => {
    mockedAuth.mockResolvedValue(session);
    mockedJobFindUnique.mockResolvedValue(jobRecord(otherJob));

    const result = await confirmImport(otherJob.id);

    expect(result.success).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expectNoWrites();
    // 応答に他店舗のファイル名・ID・行データを含めない
    const body = JSON.stringify(result);
    for (const secret of [otherJob.fileName, otherJob.shopId, RAW_ROW.name]) expect(body).not.toContain(secret);
  });

  it("ケースD: 未ログインではジョブを検索せず拒否され、副作用がない", async () => {
    mockedAuth.mockResolvedValue(null);

    const result = await confirmImport(JOB_A.id);

    expect(result.error).toBeDefined();
    expect(mockedJobFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("ケースE: 存在しないジョブIDは拒否され、副作用がない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedJobFindUnique.mockResolvedValue(null);

    const result = await confirmImport(MISSING_ID);

    expect(result.error).toBeDefined();
    expectNoWrites();
  });

  it("他店舗のジョブと存在しないジョブで応答が同一（存在を推測できない）", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedJobFindUnique.mockResolvedValueOnce(jobRecord(JOB_B));
    const otherShop = await confirmImport(JOB_B.id);

    mockedJobFindUnique.mockResolvedValueOnce(null);
    const missing = await confirmImport(MISSING_ID);

    expect(otherShop).toEqual(missing);
  });

  it.each(["COMPLETED", "PROCESSING", "FAILED"])("ケースF: 自店の%sジョブは再確定できず、副作用がない", async (status) => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedJobFindUnique.mockResolvedValue(jobRecord(JOB_A, status));

    const result = await confirmImport(JOB_A.id);

    expect(result.error).toBeDefined();
    expectNoWrites();
  });
});

describe("confirmImport: 同じproduct_codeが両店舗にある場合の分離", () => {
  it("店舗BにだけTEST-001があるとき、店舗Aの確定は店舗Aに新規作成し、店舗Bの商品を更新しない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedJobFindUnique.mockResolvedValue(jobRecord(JOB_A));
    seedProducts([existingProduct(PRODUCT_B, 900000)]);

    const result = await confirmImport(JOB_A.id);

    expect(result.success).toBeDefined();
    expect(tx.product.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.product.findUnique.mock.calls[0][0].where.shopId_productCode.shopId).toBe(SHOP_A.id);
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.product.create.mock.calls[0][0].data.shopId).toBe(SHOP_A.id);
    const writes = JSON.stringify([tx.product.create, tx.priceHistory.create, tx.productHistory.create].map((m) => m.mock.calls));
    expect(writes).not.toContain(PRODUCT_B.id);
    expect(writes).not.toContain(SHOP_B.id);
  });

  it("両店舗にTEST-001があるとき、店舗Aの確定は店舗Aの商品だけを更新し、履歴も店舗Aの商品に作る", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedJobFindUnique.mockResolvedValue(jobRecord(JOB_A));
    seedProducts([existingProduct(PRODUCT_A, 1200000), existingProduct(PRODUCT_B, 900000)]);

    const result = await confirmImport(JOB_A.id);

    expect(result.success).toBeDefined();
    expect(tx.product.create).not.toHaveBeenCalled();
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.product.update.mock.calls[0][0].where).toEqual({ id: PRODUCT_A.id });
    expect(tx.priceHistory.create.mock.calls[0][0].data).toEqual({ productId: PRODUCT_A.id, oldPrice: 1200000, newPrice: 1500000 });
    expect(tx.productHistory.create.mock.calls[0][0].data.productId).toBe(PRODUCT_A.id);
    const writes = JSON.stringify([tx.product.update, tx.priceHistory.create, tx.productHistory.create].map((m) => m.mock.calls));
    expect(writes).not.toContain(PRODUCT_B.id);
  });

  it("店舗Bの確定でも同じ規則: 店舗Bの商品だけを更新し、店舗Aの商品に触れない", async () => {
    mockedAuth.mockResolvedValue(SESSION_B);
    mockedJobFindUnique.mockResolvedValue(jobRecord(JOB_B));
    seedProducts([existingProduct(PRODUCT_A, 1200000), existingProduct(PRODUCT_B, 900000)]);

    const result = await confirmImport(JOB_B.id);

    expect(result.success).toBeDefined();
    expect(tx.product.findUnique.mock.calls[0][0].where.shopId_productCode.shopId).toBe(SHOP_B.id);
    expect(tx.product.update.mock.calls[0][0].where).toEqual({ id: PRODUCT_B.id });
    const writes = JSON.stringify([tx.product.update, tx.priceHistory.create, tx.productHistory.create].map((m) => m.mock.calls));
    expect(writes).not.toContain(PRODUCT_A.id);
  });
});
