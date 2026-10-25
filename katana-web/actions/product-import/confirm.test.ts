import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// 認可はDB由来のコンテキストで行う。Actionのテストでは結果をモックし、DB照合そのものは lib/auth/context.test.ts で検証する
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getAuthContext: vi.fn() };
});

// トランザクション内（tx）とトランザクション外（prisma）の書き込みを分けて観測する
const tx = vi.hoisted(() => ({
  importJob: { update: vi.fn(), updateMany: vi.fn() },
  importRow: { update: vi.fn() },
  product: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  priceHistory: { create: vi.fn() },
  productHistory: { create: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    importJob: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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

import { Prisma } from "@prisma/client";
import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { getAuthContext } from "@/lib/auth/context";
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

function signInOnceAs(session: SessionLike) {
  mockedAuthContext.mockResolvedValueOnce(contextOf(session));
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
const mockedJobFindUnique = vi.mocked(prisma.importJob.findUnique);
const outerJobUpdateMany = vi.mocked(prisma.importJob.updateMany);
const mockedTransaction = vi.mocked(prisma.$transaction);

const ALREADY_PROCESSED = { error: "このジョブはすでに処理済みです。" };
const CONFIRM_FAILED = { error: "取込の確定処理に失敗しました。" };
const NOT_FOUND = { error: "取込ジョブが見つかりません。" };

/** 店舗Aの2人目のユーザー（同じジョブを同時に確定する別ユーザー） */
const SESSION_A2 = { ...SESSION_A, user: { ...SESSION_A.user, id: "user-avocado-2" } };

const RAW_ROW = { product_code: "TEST-001", name: "テスト刀", category: "刀", sword_era: "新刀", price: "1500000" };

// ---------------------------------------------------------------------------
// ステートフルな簡易DB（モック上の再現。実DBには接続しない）
// - findUnique: where の id と shopId の両方を評価する（shopIdが合わなければ null）
// - $transaction: 1件ずつ直列に実行し（行ロックの代わり）、作業コピーへの書き込みを
//   成功時のみcommit、例外時は破棄（rollback）する
// - トランザクション外の importJob.updateMany も同じロックを待ってから実行する
// - updateMany: where の全項目が一致する行だけを更新し、件数を返す
// ---------------------------------------------------------------------------

type RowState = {
  id: string;
  importJobId: string;
  rowNumber: number;
  productCode: string | null;
  status: string;
  rawData: Record<string, string> | null;
  message: string | null;
};
type JobState = {
  id: string;
  shopId: string;
  fileName: string;
  status: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  completedAt: Date | null;
  rows: RowState[];
};
type ProductState = ReturnType<typeof existingProduct> & {
  status: string;
  createdById?: string | null;
  updatedById?: string | null;
};
type PriceHistoryState = { productId: string; oldPrice: number | null; newPrice: number | null };
type ProductHistoryState = { productId: string; action: string; changedById: string; oldValue: unknown; newValue: unknown };
type DbState = {
  jobs: Map<string, JobState>;
  products: Map<string, ProductState>;
  priceHistories: PriceHistoryState[];
  productHistories: ProductHistoryState[];
};

function emptyState(): DbState {
  return { jobs: new Map(), products: new Map(), priceHistories: [], productHistories: [] };
}

const db = { state: emptyState() };
let working: DbState | null = null;
let lock: Promise<unknown> = Promise.resolve();

/** findUnique の応答を任意のタイミングまで保留する（同時実行の再現用）。読み取り自体は呼び出し時点で行う */
let holdReads = false;
const heldReads: Array<() => void> = [];

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

function current(): DbState {
  if (!working) throw new Error("tx client used outside of a transaction");
  return working;
}

function matches(record: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => record[key] === value);
}

function applyJobUpdateMany(state: DbState, args: { where: Record<string, unknown>; data: Partial<JobState> }) {
  let count = 0;
  for (const job of state.jobs.values()) {
    if (matches(job, args.where)) {
      Object.assign(job, args.data);
      count += 1;
    }
  }
  return { count };
}

function existingProduct(product: typeof PRODUCT_A | typeof PRODUCT_B, price: number | null) {
  return {
    id: product.id as string,
    shopId: product.shopId as string,
    productCode: product.productCode as string,
    title: "既存の刀",
    categoryId: "category-katana",
    makerId: null as string | null,
    appraiserId: null as string | null,
    gradeId: null as string | null,
    rankId: null as string | null,
    periodId: null as string | null,
    provinceId: null as string | null,
    swordEraId: "sword-era-shinto",
    price,
    bladeLength: null as number | null,
    curvature: null as number | null,
  };
}

function createdId(shopId: string, productCode = "TEST-001") {
  return `created-in-${shopId}-${productCode}`;
}

function successRow(job: typeof JOB_A | typeof JOB_B, raw: Record<string, string> = RAW_ROW, id?: string, rowNumber = 2): RowState {
  const row = job.id === JOB_A.id ? ROW_A : ROW_B;
  return { id: id ?? row.id, importJobId: job.id, rowNumber, productCode: raw.product_code, status: "SUCCESS", rawData: raw, message: null };
}

function seedJob(job: typeof JOB_A | typeof JOB_B, options: { status?: string; rows?: RowState[] } = {}) {
  const rows = options.rows ?? [successRow(job)];
  db.state.jobs.set(job.id, {
    id: job.id,
    shopId: job.shopId,
    fileName: job.fileName,
    status: options.status ?? "PENDING",
    totalRows: rows.length,
    successRows: rows.filter((r) => r.status === "SUCCESS").length,
    errorRows: rows.filter((r) => r.status === "ERROR").length,
    completedAt: null,
    rows,
  });
}

/** 両店舗のジョブが存在するDB */
function seedBothShopJobs(statusA = "PENDING") {
  seedJob(JOB_A, { status: statusA });
  seedJob(JOB_B);
}

function seedProducts(products: Array<ReturnType<typeof existingProduct> & { status?: string }>) {
  for (const p of products) db.state.products.set(p.id, { status: "ACTIVE", ...p });
}

function job(id: string) {
  return db.state.jobs.get(id)!;
}

function installDb() {
  db.state = emptyState();
  working = null;
  lock = Promise.resolve();
  holdReads = false;
  heldReads.length = 0;

  mockedJobFindUnique.mockImplementation((async (args: { where: { id?: string; shopId?: string } }) => {
    const { id, shopId } = args.where;
    const found = [...db.state.jobs.values()].find((j) => j.id === id && (shopId === undefined || j.shopId === shopId));
    const snapshot = found ? structuredClone(found) : null;
    if (holdReads) await new Promise<void>((resolve) => heldReads.push(resolve));
    return snapshot;
  }) as never);

  outerJobUpdateMany.mockImplementation((async (args: { where: Record<string, unknown>; data: Partial<JobState> }) =>
    withLock(async () => applyJobUpdateMany(db.state, args))) as never);

  mockedTransaction.mockImplementation((async (fn: unknown) => {
    if (typeof fn !== "function") throw new Error("このテストは interactive transaction のみ再現する");
    return withLock(async () => {
      working = structuredClone(db.state);
      try {
        const result = await fn(tx);
        db.state = working;
        return result;
      } finally {
        working = null;
      }
    });
  }) as never);

  tx.importJob.updateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Partial<JobState> }) =>
    applyJobUpdateMany(current(), args),
  );

  tx.importRow.update.mockImplementation(async (args: { where: { id: string }; data: Partial<RowState> }) => {
    for (const j of current().jobs.values()) {
      const row = j.rows.find((r) => r.id === args.where.id);
      if (row) return Object.assign(row, args.data);
    }
    throw new Error("ImportRow not found");
  });

  tx.product.findUnique.mockImplementation(
    async (args: { where: { shopId_productCode?: { shopId: string; productCode: string } } }) => {
      const key = args.where.shopId_productCode;
      if (!key) return null;
      const found = [...current().products.values()].find((p) => p.shopId === key.shopId && p.productCode === key.productCode);
      return found ? structuredClone(found) : null;
    },
  );

  tx.product.create.mockImplementation(async (args: { data: ProductState }) => {
    const state = current();
    const duplicate = [...state.products.values()].some((p) => p.shopId === args.data.shopId && p.productCode === args.data.productCode);
    if (duplicate) throw new Error("Unique constraint failed on (shopId, productCode)");
    const created = { ...args.data, id: createdId(args.data.shopId, args.data.productCode) };
    state.products.set(created.id, created);
    return created;
  });

  tx.product.update.mockImplementation(async (args: { where: { id: string }; data: Partial<ProductState> }) => {
    const product = current().products.get(args.where.id);
    if (!product) throw new Error("Product not found");
    return Object.assign(product, args.data);
  });

  tx.priceHistory.create.mockImplementation(async (args: { data: PriceHistoryState }) => {
    current().priceHistories.push(args.data);
    return args.data;
  });

  tx.productHistory.create.mockImplementation(async (args: { data: ProductHistoryState }) => {
    current().productHistories.push(args.data);
    return args.data;
  });
}

/** 保留中の非同期処理を進める */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** n件の確定要求を、全員がPENDINGを読み取った後に同時に進める */
async function confirmConcurrently(sessions: unknown[], jobId = JOB_A.id) {
  for (const session of sessions) signInOnceAs(session as SessionLike);
  holdReads = true;
  const requests = sessions.map(() => confirmImport(jobId));
  await flush();
  // 全リクエストが読み取りを終えた（PENDINGを確認した）状態で、同時に処理を進める
  expect(heldReads).toHaveLength(sessions.length);
  heldReads.splice(0).forEach((release) => release());
  const results = await Promise.all(requests);
  for (const read of mockedJobFindUnique.mock.results) await expect(read.value).resolves.toMatchObject({ status: "PENDING" });
  return results;
}

function dataWriteMocks() {
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

/** トランザクションを開始せず、何も書き込んでいない */
function expectNoWrites() {
  expect(mockedTransaction).not.toHaveBeenCalled();
  expect(tx.importJob.updateMany).not.toHaveBeenCalled();
  expect(outerJobUpdateMany).not.toHaveBeenCalled();
  for (const mock of dataWriteMocks()) expect(mock).not.toHaveBeenCalled();
}

/** CSVの反映（商品・履歴・行）とFAILED記録が一切行われていない */
function expectNoCsvReflection() {
  for (const mock of dataWriteMocks()) expect(mock).not.toHaveBeenCalled();
  expect(outerJobUpdateMany).not.toHaveBeenCalled();
  expect(db.state.priceHistories).toHaveLength(0);
  expect(db.state.productHistories).toHaveLength(0);
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockReset();
  mockedAuthContext.mockReset();
  mockedUserFindUnique.mockReset();
  for (const mock of [mockedJobFindUnique, outerJobUpdateMany, mockedTransaction, ...Object.values(tx).flatMap((m) => Object.values(m))]) {
    vi.mocked(mock).mockReset();
  }
  installDb();
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
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("confirmImport: 店舗間の認可", () => {
  it("ケースA: 店舗Aのユーザーは店舗AのPENDINGジョブを確定でき、書き込みはすべて店舗Aに限られる", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual({ success: "取込を確定しました。" });
    expect(mockedJobFindUnique).toHaveBeenCalledWith({ where: { id: JOB_A.id, shopId: SHOP_A.id }, include: { rows: true } });
    expect(tx.importJob.updateMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { id: JOB_A.id, shopId: SHOP_A.id, status: "PENDING" }, data: { status: "PROCESSING" } },
      { where: { id: JOB_A.id, shopId: SHOP_A.id, status: "PROCESSING" }, data: { status: "COMPLETED", completedAt: expect.any(Date) } },
    ]);
    expect(tx.importJob.update).not.toHaveBeenCalled();
    expect(tx.product.findUnique).toHaveBeenCalledWith({
      where: { shopId_productCode: { shopId: SHOP_A.id, productCode: "TEST-001" } },
    });
    expect(tx.product.create.mock.calls[0][0].data).toMatchObject({
      shopId: SHOP_A.id,
      productCode: "TEST-001",
      createdById: USER_A.id,
      status: "ACTIVE",
    });
    expect(tx.priceHistory.create.mock.calls[0][0].data).toEqual({ productId: createdId(SHOP_A.id), oldPrice: null, newPrice: 1500000 });
    expect(tx.productHistory.create.mock.calls[0][0].data).toMatchObject({
      productId: createdId(SHOP_A.id),
      action: "IMPORT",
      changedById: USER_A.id,
    });
    expect(job(JOB_A.id)).toMatchObject({ status: "COMPLETED", completedAt: expect.any(Date) });
    expect(job(JOB_B.id)).toMatchObject({ status: "PENDING", completedAt: null });
    expect(outerJobUpdateMany).not.toHaveBeenCalled();
    const writes = JSON.stringify([...dataWriteMocks(), tx.importJob.updateMany].map((m) => vi.mocked(m).mock.calls));
    expect(writes).not.toContain(SHOP_B.id);
  });

  it.each([
    ["ケースB: 店舗A → 店舗BのジョブID", SESSION_A, JOB_B],
    ["ケースC: 店舗B → 店舗AのジョブID", SESSION_B, JOB_A],
  ])("%s は拒否され、ジョブ・商品・履歴・行のいずれも更新されない", async (_label, session, otherJob) => {
    signInAs(session);
    seedBothShopJobs();

    const result = await confirmImport(otherJob.id);

    expect(result).toEqual(NOT_FOUND);
    // F-06: 取得条件はセッションのshopIdで絞られ、他店舗のジョブ（と行）はDB取得の時点でnullになる
    expect(mockedJobFindUnique).toHaveBeenCalledTimes(1);
    expect(mockedJobFindUnique).toHaveBeenCalledWith({
      where: { id: otherJob.id, shopId: session.user.shopId },
      include: { rows: true },
    });
    expect(session.user.shopId).not.toBe(otherJob.shopId);
    await expect(mockedJobFindUnique.mock.results[0].value).resolves.toBeNull();
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expectNoWrites();
    expect(job(otherJob.id).status).toBe("PENDING");
    // 応答に他店舗のファイル名・ID・行データを含めない
    const body = JSON.stringify(result);
    for (const secret of [otherJob.fileName, otherJob.shopId, RAW_ROW.name]) expect(body).not.toContain(secret);
  });

  it("ケースD: 未ログインではジョブを検索せず拒否され、副作用がない", async () => {
    denyAuth("UNAUTHENTICATED");
    seedBothShopJobs();

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(mockedJobFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(["USER_NOT_FOUND", "SHOP_INACTIVE"] as const)("ケースD': DB照合が %s なら拒否され、副作用がない", async (reason) => {
    denyAuth(reason);
    seedBothShopJobs();

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(mockedJobFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("ケースE: 存在しないジョブIDは拒否され、副作用がない", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    const result = await confirmImport(MISSING_ID);

    expect(result).toEqual(NOT_FOUND);
    expect(mockedJobFindUnique).toHaveBeenCalledWith({ where: { id: MISSING_ID, shopId: SHOP_A.id }, include: { rows: true } });
    expectNoWrites();
  });

  it("他店舗のジョブと存在しないジョブで応答が同一（存在を推測できない）", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    const otherShop = await confirmImport(JOB_B.id);
    const missing = await confirmImport(MISSING_ID);

    expect(otherShop).toEqual(missing);
    expect(otherShop).toEqual(NOT_FOUND);
  });

  it("多層防御: 取得結果に他店舗のジョブが混入しても、shopId照合で拒否され副作用がない", async () => {
    // 取得条件が将来誤って緩められた場合を想定し、DB層がshopIdを無視して返すケースを再現する
    signInAs(SESSION_A);
    seedBothShopJobs();
    mockedJobFindUnique.mockResolvedValue(structuredClone(job(JOB_B.id)) as never);

    const result = await confirmImport(JOB_B.id);

    expect(result).toEqual(NOT_FOUND);
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(["COMPLETED", "PROCESSING", "FAILED"])("ケースF: 自店の%sジョブは再確定できず、副作用がない", async (status) => {
    signInAs(SESSION_A);
    seedBothShopJobs(status);

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(ALREADY_PROCESSED);
    expectNoWrites();
    expect(job(JOB_A.id).status).toBe(status);
  });
});

describe("confirmImport: 同じproduct_codeが両店舗にある場合の分離", () => {
  it("店舗BにだけTEST-001があるとき、店舗Aの確定は店舗Aに新規作成し、店舗Bの商品を更新しない", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();
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
    expect(db.state.products.get(PRODUCT_B.id)).toMatchObject({ price: 900000 });
  });

  it("両店舗にTEST-001があるとき、店舗Aの確定は店舗Aの商品だけを更新し、履歴も店舗Aの商品に作る", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();
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
    expect(db.state.products.get(PRODUCT_B.id)).toMatchObject({ price: 900000 });
  });

  it("店舗Bの確定でも同じ規則: 店舗Bの商品だけを更新し、店舗Aの商品に触れない", async () => {
    signInAs(SESSION_B);
    seedBothShopJobs();
    seedProducts([existingProduct(PRODUCT_A, 1200000), existingProduct(PRODUCT_B, 900000)]);

    const result = await confirmImport(JOB_B.id);

    expect(result.success).toBeDefined();
    expect(tx.importJob.updateMany.mock.calls[0][0].where).toEqual({ id: JOB_B.id, shopId: SHOP_B.id, status: "PENDING" });
    expect(tx.product.findUnique.mock.calls[0][0].where.shopId_productCode.shopId).toBe(SHOP_B.id);
    expect(tx.product.update.mock.calls[0][0].where).toEqual({ id: PRODUCT_B.id });
    const writes = JSON.stringify([tx.product.update, tx.priceHistory.create, tx.productHistory.create].map((m) => m.mock.calls));
    expect(writes).not.toContain(PRODUCT_A.id);
    expect(db.state.products.get(PRODUCT_A.id)).toMatchObject({ price: 1200000 });
  });
});

describe("confirmImport: 既存の確定処理の回帰", () => {
  it("CSV部分成功: ERROR行は反映せず、確定時の再検証で不正になった行はERRORへ更新し、正常行だけ反映する", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A, {
      rows: [
        { ...successRow(JOB_A, { ...RAW_ROW, product_code: "ERR-001" }, "row-error", 2), status: "ERROR", message: "検証エラー" },
        successRow(JOB_A, { ...RAW_ROW, product_code: "STALE-001", category: "削除済み種類" }, "row-stale", 3),
        successRow(JOB_A, RAW_ROW, "row-ok", 4),
      ],
    });

    const result = await confirmImport(JOB_A.id);

    expect(result.success).toBeDefined();
    expect(tx.importRow.update).toHaveBeenCalledTimes(1);
    expect(tx.importRow.update.mock.calls[0][0]).toMatchObject({ where: { id: "row-stale" }, data: { status: "ERROR" } });
    expect(tx.product.create).toHaveBeenCalledTimes(1);
    expect(tx.product.create.mock.calls[0][0].data.productCode).toBe("TEST-001");
    expect(tx.importJob.updateMany.mock.calls.map(([args]) => args.data.status)).toEqual(["PROCESSING", "COMPLETED"]);
    const rows = job(JOB_A.id).rows;
    expect(rows.find((r) => r.id === "row-stale")).toMatchObject({ status: "ERROR", message: expect.stringContaining("削除済み種類") });
    expect(rows.find((r) => r.id === "row-error")).toMatchObject({ status: "ERROR", message: "検証エラー" });
    // successRows / errorRows はアップロード時の検証結果のまま（確定時には更新しない既存仕様）
    expect(job(JOB_A.id)).toMatchObject({ status: "COMPLETED", totalRows: 3, successRows: 2, errorRows: 1 });
  });

  it("新規商品: ACTIVEで作成し、価格ありならPriceHistory(old=null)とProductHistory(IMPORT, old=null)を作る", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);

    await confirmImport(JOB_A.id);

    expect(db.state.products.get(createdId(SHOP_A.id))).toMatchObject({
      shopId: SHOP_A.id,
      productCode: "TEST-001",
      status: "ACTIVE",
      price: 1500000,
      createdById: USER_A.id,
      updatedById: USER_A.id,
      listedAt: expect.any(Date),
    });
    expect(db.state.priceHistories).toEqual([{ productId: createdId(SHOP_A.id), oldPrice: null, newPrice: 1500000 }]);
    expect(db.state.productHistories).toHaveLength(1);
    expect(db.state.productHistories[0]).toMatchObject({ action: "IMPORT", changedById: USER_A.id });
    expect(tx.productHistory.create.mock.calls[0][0].data.oldValue).toBe(Prisma.JsonNull);
  });

  it("既存商品: 項目と価格を更新し、変更前後をProductHistoryに記録する", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    seedProducts([existingProduct(PRODUCT_A, 1200000)]);

    await confirmImport(JOB_A.id);

    expect(db.state.products.get(PRODUCT_A.id)).toMatchObject({ title: "テスト刀", price: 1500000, updatedById: USER_A.id });
    expect(db.state.priceHistories).toEqual([{ productId: PRODUCT_A.id, oldPrice: 1200000, newPrice: 1500000 }]);
    expect(db.state.productHistories[0]).toMatchObject({
      productId: PRODUCT_A.id,
      action: "IMPORT",
      changedById: USER_A.id,
      oldValue: { title: "既存の刀", price: 1200000 },
      newValue: { title: "テスト刀", price: 1500000 },
    });
  });

  it("SOLD商品: statusはSOLDのまま、既存仕様どおり項目・価格を更新しPriceHistoryも作る", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    seedProducts([{ ...existingProduct(PRODUCT_A, 1200000), status: "SOLD" }]);

    await confirmImport(JOB_A.id);

    expect(tx.product.update.mock.calls[0][0].data).not.toHaveProperty("status");
    expect(db.state.products.get(PRODUCT_A.id)).toMatchObject({ status: "SOLD", price: 1500000 });
    expect(db.state.priceHistories).toEqual([{ productId: PRODUCT_A.id, oldPrice: 1200000, newPrice: 1500000 }]);
  });

  it.each([
    ["既存商品で価格が同じ", 1500000, "1500000", 0],
    ["既存商品で価格が変わる", 1200000, "1500000", 1],
    ["既存商品で価格がnullになる", 1200000, "", 1],
  ])("PriceHistoryの価格変更判定: %s → %i件", async (_label, oldPrice, newPriceRaw, expected) => {
    signInAs(SESSION_A);
    seedJob(JOB_A, { rows: [successRow(JOB_A, { ...RAW_ROW, price: newPriceRaw })] });
    seedProducts([existingProduct(PRODUCT_A, oldPrice)]);

    await confirmImport(JOB_A.id);

    expect(db.state.priceHistories).toHaveLength(expected);
    // ProductHistory(IMPORT)は価格の変化に関係なく作成する
    expect(db.state.productHistories).toHaveLength(1);
  });

  it("PriceHistoryの価格変更判定: 価格なしの新規商品は価格履歴を作らない", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A, { rows: [successRow(JOB_A, { ...RAW_ROW, price: "" })] });

    await confirmImport(JOB_A.id);

    expect(db.state.products.get(createdId(SHOP_A.id))).toMatchObject({ price: null });
    expect(db.state.priceHistories).toHaveLength(0);
    expect(db.state.productHistories).toHaveLength(1);
  });

  it("トランザクションのtimeout設定（30000ms）を維持する", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);

    await confirmImport(JOB_A.id);

    expect(mockedTransaction.mock.calls[0][1]).toEqual({ timeout: 30000 });
  });
});

describe("confirmImport: 実行権の取得（F-04）", () => {
  it("実行権の取得条件に id・セッションのshopId・status: PENDING がすべて含まれ、最初の書き込みである", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);

    await confirmImport(JOB_A.id);

    expect(tx.importJob.updateMany.mock.calls[0][0]).toEqual({
      where: { id: JOB_A.id, shopId: SHOP_A.id, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    const firstWriteOrder = Math.min(
      ...[tx.importRow.update, tx.product.create, tx.product.update, tx.priceHistory.create, tx.productHistory.create].flatMap(
        (m) => m.mock.invocationCallOrder,
      ),
    );
    expect(tx.importJob.updateMany.mock.invocationCallOrder[0]).toBeLessThan(firstWriteOrder);
  });

  it("事前確認後に別リクエストが確定済み（実行権取得0件）なら、CSVを反映せず「すでに処理済み」を返し、FAILEDにしない", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    const completedAt = new Date("2026-10-01T00:00:00Z");
    // 事前確認（findUnique）ではPENDINGを返すが、実行権取得の時点では別リクエストがCOMPLETEDにしている状態
    mockedJobFindUnique.mockResolvedValueOnce(structuredClone(job(JOB_A.id)) as never);
    Object.assign(job(JOB_A.id), { status: "COMPLETED", completedAt });

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(ALREADY_PROCESSED);
    await expect(tx.importJob.updateMany.mock.results[0].value).resolves.toEqual({ count: 0 });
    expect(tx.importJob.updateMany).toHaveBeenCalledTimes(1);
    expectNoCsvReflection();
    expect(job(JOB_A.id)).toMatchObject({ status: "COMPLETED", completedAt });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("実行権の取得件数が想定外（2件以上）なら、CSVを反映せず拒否し、更新はrollbackされる", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    tx.importJob.updateMany.mockImplementationOnce(async (args: { where: Record<string, unknown>; data: Partial<JobState> }) => {
      applyJobUpdateMany(current(), args);
      return { count: 2 };
    });

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(ALREADY_PROCESSED);
    expectNoCsvReflection();
    expect(job(JOB_A.id).status).toBe("PENDING");
  });
});

describe("confirmImport: 失敗時の状態遷移（F-04）", () => {
  it("実行権取得後に途中で失敗すると、商品・履歴・行の反映がすべてrollbackされ、ジョブはFAILEDになる", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A, {
      rows: [
        successRow(JOB_A, { ...RAW_ROW, product_code: "STALE-001", category: "削除済み種類" }, "row-stale", 2),
        successRow(JOB_A, { ...RAW_ROW, product_code: "NEW-001" }, "row-new", 3),
        successRow(JOB_A, RAW_ROW, "row-fail", 4),
      ],
    });
    seedProducts([existingProduct(PRODUCT_A, 1200000)]);
    // 3行目（既存商品の更新）で失敗させる
    tx.product.update.mockRejectedValueOnce(new Error("product update failed"));

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(CONFIRM_FAILED);
    // 途中までの書き込み（ERROR更新・新規作成・履歴）は実行されたが、commitされていない
    expect(tx.importRow.update).toHaveBeenCalledTimes(1);
    expect(tx.product.create).toHaveBeenCalledTimes(1);
    expect(db.state.products.has(createdId(SHOP_A.id, "NEW-001"))).toBe(false);
    expect(db.state.products.get(PRODUCT_A.id)).toMatchObject({ price: 1200000, title: "既存の刀" });
    expect(db.state.priceHistories).toHaveLength(0);
    expect(db.state.productHistories).toHaveLength(0);
    expect(job(JOB_A.id).rows.find((r) => r.id === "row-stale")).toMatchObject({ status: "SUCCESS", message: null });
    // rollbackでPENDINGに戻った後、PENDINGを条件にFAILEDへ変更する
    expect(outerJobUpdateMany).toHaveBeenCalledTimes(1);
    expect(outerJobUpdateMany).toHaveBeenCalledWith({
      where: { id: JOB_A.id, shopId: SHOP_A.id, status: "PENDING" },
      data: { status: "FAILED", completedAt: expect.any(Date) },
    });
    expect(job(JOB_A.id)).toMatchObject({ status: "FAILED", completedAt: expect.any(Date) });
    expect(prisma.importJob.update).not.toHaveBeenCalled();
  });

  it.each([
    ["ProductHistory作成", () => tx.productHistory.create.mockRejectedValueOnce(new Error("history failed"))],
    ["PriceHistory作成", () => tx.priceHistory.create.mockRejectedValueOnce(new Error("price history failed"))],
    ["Product作成", () => tx.product.create.mockRejectedValueOnce(new Error("create failed"))],
  ])("実行権取得後の%sの失敗でもrollbackされ、ジョブはFAILEDになる", async (_label, inject) => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    inject();

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(CONFIRM_FAILED);
    expect(db.state.products.size).toBe(0);
    expect(db.state.priceHistories).toHaveLength(0);
    expect(db.state.productHistories).toHaveLength(0);
    expect(job(JOB_A.id).status).toBe("FAILED");
  });

  it("COMPLETEDへの更新が0件（ジョブがPROCESSINGでなくなった）なら、トランザクション全体をrollbackしてFAILEDにする", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    // 反映中にジョブの状態が想定外に変わった状況を、トランザクション内の状態で再現する
    tx.productHistory.create.mockImplementationOnce(async (args: { data: ProductHistoryState }) => {
      current().jobs.get(JOB_A.id)!.status = "FAILED";
      current().productHistories.push(args.data);
      return args.data;
    });

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(CONFIRM_FAILED);
    await expect(tx.importJob.updateMany.mock.results[1].value).resolves.toEqual({ count: 0 });
    expect(tx.product.create).toHaveBeenCalledTimes(1);
    expect(db.state.products.size).toBe(0);
    expect(db.state.productHistories).toHaveLength(0);
    expect(job(JOB_A.id)).toMatchObject({ status: "FAILED", completedAt: expect.any(Date) });
  });

  it("実行権取得前の失敗（ロック待ちのtimeoutなど）ではFAILEDにせず、一般エラーを返す", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    tx.importJob.updateMany.mockRejectedValueOnce(new Error("Transaction already closed: timeout"));

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(CONFIRM_FAILED);
    expectNoCsvReflection();
    expect(job(JOB_A.id)).toMatchObject({ status: "PENDING", completedAt: null });
  });

  it("COMPLETED済みのジョブを、実行権を取得できなかった後続リクエストの失敗でFAILEDに上書きしない", async () => {
    seedJob(JOB_A);
    signInAs(SESSION_A);
    await confirmImport(JOB_A.id);
    const completedAt = job(JOB_A.id).completedAt;
    expect(job(JOB_A.id).status).toBe("COMPLETED");
    vi.clearAllMocks();

    // 後続リクエスト: 事前確認ではPENDINGを読んでいたが、ロック待ちの間にtimeoutした
    mockedJobFindUnique.mockResolvedValueOnce({ ...structuredClone(job(JOB_A.id)), status: "PENDING" } as never);
    tx.importJob.updateMany.mockRejectedValueOnce(new Error("Transaction already closed: timeout"));
    signInAs(SESSION_A2);
    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual(CONFIRM_FAILED);
    expect(outerJobUpdateMany).not.toHaveBeenCalled();
    expect(job(JOB_A.id)).toMatchObject({ status: "COMPLETED", completedAt });
    expect(db.state.productHistories).toHaveLength(1);
  });

  it("FAILEDへの更新自体が失敗した場合は、既存どおり例外をそのまま投げ、再試行しない（ジョブはPENDINGのまま）", async () => {
    signInAs(SESSION_A);
    seedJob(JOB_A);
    tx.productHistory.create.mockRejectedValueOnce(new Error("history failed"));
    outerJobUpdateMany.mockRejectedValueOnce(new Error("failed to record FAILED"));

    await expect(confirmImport(JOB_A.id)).rejects.toThrow("failed to record FAILED");

    expect(outerJobUpdateMany).toHaveBeenCalledTimes(1);
    expect(job(JOB_A.id)).toMatchObject({ status: "PENDING", completedAt: null });
    expect(db.state.products.size).toBe(0);
  });
});

describe("confirmImport: 同時確定（F-04、モック上の再現）", () => {
  /** 新規商品・既存商品の価格変更・確定時に不正になる行を含むジョブ */
  function seedMixedJob() {
    seedJob(JOB_A, {
      rows: [
        successRow(JOB_A, { ...RAW_ROW, product_code: "NEW-001" }, "row-new", 2),
        successRow(JOB_A, RAW_ROW, "row-existing", 3),
        successRow(JOB_A, { ...RAW_ROW, product_code: "STALE-001", category: "削除済み種類" }, "row-stale", 4),
      ],
    });
    seedProducts([existingProduct(PRODUCT_A, 1200000)]);
  }

  it("2件同時: 両方がPENDINGを読んでも成功は1件だけで、CSVの反映・履歴・行の更新は1回分だけ", async () => {
    seedMixedJob();

    const results = await confirmConcurrently([SESSION_A, SESSION_A2]);

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toEqual([ALREADY_PROCESSED]);
    const claims = await Promise.all(
      tx.importJob.updateMany.mock.calls
        .map((call, i) => [call[0].data.status, tx.importJob.updateMany.mock.results[i].value] as const)
        .filter(([status]) => status === "PROCESSING")
        .map(([, value]) => value),
    );
    expect(claims).toEqual([{ count: 1 }, { count: 0 }]);
    expect(tx.product.create).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.importRow.update).toHaveBeenCalledTimes(1);
    expect(db.state.products.size).toBe(2);
    expect(db.state.priceHistories).toEqual([
      { productId: createdId(SHOP_A.id, "NEW-001"), oldPrice: null, newPrice: 1500000 },
      { productId: PRODUCT_A.id, oldPrice: 1200000, newPrice: 1500000 },
    ]);
    expect(db.state.productHistories).toHaveLength(2);
    expect(new Set(db.state.productHistories.map((h) => h.changedById)).size).toBe(1);
    expect(job(JOB_A.id).status).toBe("COMPLETED");
    expect(outerJobUpdateMany).not.toHaveBeenCalled();
  });

  it("3件同時: 成功は1件だけで、残り2件は「すでに処理済み」になりFAILEDを書き込まない", async () => {
    seedMixedJob();
    const SESSION_A3 = { ...SESSION_A, user: { ...SESSION_A.user, id: "user-avocado-3" } };

    const results = await confirmConcurrently([SESSION_A, SESSION_A2, SESSION_A3]);

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toEqual([ALREADY_PROCESSED, ALREADY_PROCESSED]);
    expect(tx.product.create).toHaveBeenCalledTimes(1);
    expect(tx.importRow.update).toHaveBeenCalledTimes(1);
    expect(db.state.priceHistories).toHaveLength(2);
    expect(db.state.productHistories).toHaveLength(2);
    expect(job(JOB_A.id).status).toBe("COMPLETED");
    expect(outerJobUpdateMany).not.toHaveBeenCalled();
  });

  it("2件同時でcompletedAtは先行リクエストの値のまま上書きされない", async () => {
    seedMixedJob();

    await confirmConcurrently([SESSION_A, SESSION_A2]);

    const completedCalls = tx.importJob.updateMany.mock.calls.filter(([args]) => args.data.status === "COMPLETED");
    expect(completedCalls).toHaveLength(1);
    expect(job(JOB_A.id).completedAt).toBe(completedCalls[0][0].data.completedAt);
  });

  it("ケース1: Aの失敗後、AのFAILED記録が先に完了すると、待機していたBは実行権を取得できない", async () => {
    seedJob(JOB_A);
    signInOnceAs(SESSION_A);
    signInOnceAs(SESSION_A2);
    holdReads = true;
    const requestA = confirmImport(JOB_A.id);
    const requestB = confirmImport(JOB_A.id);
    await flush();
    expect(heldReads).toHaveLength(2);
    tx.productHistory.create.mockRejectedValueOnce(new Error("history failed"));

    heldReads[0]();
    const resultA = await requestA;
    expect(resultA).toEqual(CONFIRM_FAILED);
    expect(job(JOB_A.id).status).toBe("FAILED");

    heldReads[1]();
    const resultB = await requestB;

    expect(resultB).toEqual(ALREADY_PROCESSED);
    expect(job(JOB_A.id).status).toBe("FAILED");
    expect(db.state.products.size).toBe(0);
    expect(db.state.productHistories).toHaveLength(0);
    expect(outerJobUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("ケース2: Aの失敗後、Bの確定が先にCOMPLETEDになると、AのFAILED記録は0件でCOMPLETEDが維持される", async () => {
    seedJob(JOB_A);
    signInOnceAs(SESSION_A);
    signInOnceAs(SESSION_A2);
    let failA!: () => void;
    tx.productHistory.create.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (failA = resolve));
      throw new Error("history failed");
    });
    holdReads = true;
    const requestA = confirmImport(JOB_A.id);
    const requestB = confirmImport(JOB_A.id);
    await flush();
    expect(heldReads).toHaveLength(2);

    // A: 実行権を取得し、処理途中（履歴作成）で止まる
    heldReads[0]();
    await flush();
    expect(failA).toBeDefined();
    // B: PENDINGを読んだ状態で進み、Aのトランザクション終了を待つ
    heldReads[1]();
    await flush();
    // A: 失敗してrollback → Bが実行権を取得してCOMPLETED → AのFAILED記録は条件不一致
    failA();
    const [resultA, resultB] = await Promise.all([requestA, requestB]);

    expect(resultA).toEqual(CONFIRM_FAILED);
    expect(resultB).toEqual({ success: "取込を確定しました。" });
    expect(outerJobUpdateMany).toHaveBeenCalledTimes(1);
    expect(outerJobUpdateMany.mock.calls[0][0].where).toEqual({ id: JOB_A.id, shopId: SHOP_A.id, status: "PENDING" });
    await expect(outerJobUpdateMany.mock.results[0].value).resolves.toEqual({ count: 0 });
    expect(job(JOB_A.id)).toMatchObject({ status: "COMPLETED", completedAt: expect.any(Date) });
    expect(db.state.products.size).toBe(1);
    expect(db.state.productHistories).toEqual([expect.objectContaining({ changedById: "user-avocado-2", action: "IMPORT" })]);
    expect(db.state.priceHistories).toHaveLength(1);
  });

  it("他店舗のユーザーが同時に確定しても、自店の1件だけが成功し他店舗の要求は何も書き込まない", async () => {
    seedBothShopJobs();
    signInOnceAs(SESSION_A);
    signInOnceAs(SESSION_B);
    holdReads = true;
    const requests = Promise.all([confirmImport(JOB_A.id), confirmImport(JOB_A.id)]);
    await flush();
    heldReads.splice(0).forEach((release) => release());
    const [own, other] = await requests;

    expect(own.success).toBeDefined();
    expect(other).toEqual(NOT_FOUND);
    expect(mockedTransaction).toHaveBeenCalledTimes(1);
    expect(db.state.productHistories).toHaveLength(1);
    expect(job(JOB_B.id).status).toBe("PENDING");
  });
});

describe("confirmImport: DB由来の認可コンテキスト（F-01-C）", () => {
  it("DB上の所属が店舗Bなら、店舗Bのジョブを店舗Bのスコープで確定し、店舗Aのジョブは見つからない", async () => {
    seedBothShopJobs();
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "STORE" } });

    const former = await confirmImport(JOB_A.id);
    const own = await confirmImport(JOB_B.id);

    expect(former).toEqual(NOT_FOUND);
    expect(mockedJobFindUnique).toHaveBeenCalledWith({ where: { id: JOB_A.id, shopId: SHOP_B.id }, include: { rows: true } });
    expect(own).toEqual({ success: "取込を確定しました。" });
    // F-04の条件付き更新は維持したまま、shopIdだけがDB由来になる
    expect(tx.importJob.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: JOB_B.id, shopId: SHOP_B.id, status: "PENDING" },
      { id: JOB_B.id, shopId: SHOP_B.id, status: "PROCESSING" },
    ]);
    expect(tx.product.findUnique).toHaveBeenCalledWith({
      where: { shopId_productCode: { shopId: SHOP_B.id, productCode: "TEST-001" } },
    });
    expect(tx.product.create.mock.calls[0][0].data).toMatchObject({ shopId: SHOP_B.id, createdById: USER_A.id });
    expect(tx.productHistory.create.mock.calls[0][0].data.changedById).toBe(USER_A.id);
    expect(job(JOB_A.id).status).toBe("PENDING");
    expect(job(JOB_B.id).status).toBe("COMPLETED");
  });

  it("claim後の失敗時のFAILED記録も、DB由来のshopIdを条件にする", async () => {
    seedBothShopJobs();
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "STORE" } });
    tx.productHistory.create.mockRejectedValueOnce(new Error("history failed"));

    const result = await confirmImport(JOB_B.id);

    expect(result).toEqual(CONFIRM_FAILED);
    expect(outerJobUpdateMany).toHaveBeenCalledWith({
      where: { id: JOB_B.id, shopId: SHOP_B.id, status: "PENDING" },
      data: { status: "FAILED", completedAt: expect.any(Date) },
    });
    expect(job(JOB_B.id).status).toBe("FAILED");
  });

  it("実際の認可ヘルパー経由: JWTは店舗A・ADMIN、DBは店舗B・STOREなら店舗Bのジョブだけ確定できる", async () => {
    seedBothShopJobs();
    useRealAuthContext(SESSION_A, { id: USER_A.id, shopId: SHOP_B.id, role: "STORE", shop: { isActive: true } });

    const former = await confirmImport(JOB_A.id);
    const own = await confirmImport(JOB_B.id);

    expect(former).toEqual(NOT_FOUND);
    expect(own.success).toBeDefined();
    expect(mockedUserFindUnique.mock.calls[0][0]).toMatchObject({ where: { id: USER_A.id } });
    expect(job(JOB_A.id).status).toBe("PENDING");
    expect(job(JOB_B.id).status).toBe("COMPLETED");
    expect(JSON.stringify(tx.importJob.updateMany.mock.calls)).not.toContain(SHOP_A.id);
  });

  it.each([
    ["店舗が無効", { id: USER_A.id, shopId: SHOP_A.id, role: "ADMIN", shop: { isActive: false } }],
    ["ユーザーが削除済み", null],
  ])("実際の認可ヘルパー経由: DB上で%sなら、JWTが有効でも拒否し、ジョブを検索せず書き込まない", async (_label, dbUser) => {
    seedBothShopJobs();
    useRealAuthContext(SESSION_A, dbUser);

    const result = await confirmImport(JOB_A.id);

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(mockedJobFindUnique).not.toHaveBeenCalled();
    expect(loadMasterCaches).not.toHaveBeenCalled();
    expectNoWrites();
    expect(job(JOB_A.id).status).toBe("PENDING");
  });

  it("getAuthContext() が例外（DB障害など）なら伝播し、古いJWTで処理を続けない", async () => {
    seedBothShopJobs();
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedAuthContext.mockRejectedValue(new Error("db down"));

    await expect(confirmImport(JOB_A.id)).rejects.toThrow("db down");
    expect(mockedJobFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
    expect(job(JOB_A.id).status).toBe("PENDING");
  });

  it("入口で getAuthContext() を1回だけ呼び、auth() を直接呼ばない", async () => {
    seedBothShopJobs();
    signInAs(SESSION_A);

    await confirmImport(JOB_A.id);

    expect(mockedAuthContext).toHaveBeenCalledTimes(1);
    expect(mockedAuth).not.toHaveBeenCalled();
  });
});
