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

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    productHistory: {
      create: vi.fn(),
    },
    priceHistory: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { getAuthContext } from "@/lib/auth/context";
import { prisma } from "@/lib/prisma";
import { MISSING_ID, PRODUCT_A, PRODUCT_B, SESSION_A, SESSION_B, SHOP_A, SHOP_B, USER_A, USER_B } from "@/lib/testing/tenantFixtures";
import { markProductAsSold } from "./markSold";

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
const mockedFindUnique = vi.mocked(prisma.product.findUnique);
const mockedTransaction = vi.mocked(prisma.$transaction);

const NOT_FOUND = { error: "商品が見つかりません。" };
const NOT_ACTIVE = { error: "この商品はすでに販売済み、または対象外の状態です。" };

const SESSION = {
  user: { id: "user-1", shopId: "shop-1", role: "STORE" },
} as never;

type ProductRow = {
  id: string;
  shopId: string;
  status: string;
  productCode?: string;
  soldAt?: Date | null;
  updatedById?: string | null;
};
type HistoryRow = { productId: string; action: string; changedById: string; oldValue: unknown; newValue: unknown };

/** トランザクション内のクライアント（tx）。トランザクション外（prisma）の書き込みとは分けて観測する */
const tx = {
  product: { updateMany: vi.fn(), update: vi.fn() },
  productHistory: { create: vi.fn() },
  priceHistory: { create: vi.fn() },
};

/**
 * 実DBに近い振る舞いをする簡易DB（モック上の再現。実DBには接続しない）。
 * - findUnique: where の id と shopId の両方を評価する（shopIdが合わなければ null）
 * - $transaction: 1件ずつ直列に実行し（行ロックの代わり）、作業コピーへの書き込みを
 *   成功時のみcommit、例外時は破棄（rollback）する
 * - updateMany: where の全項目が一致する行だけを更新し、件数を返す
 */
const db = {
  products: new Map<string, ProductRow>(),
  histories: [] as HistoryRow[],
  failHistoryCreate: false,
};

let working: { products: Map<string, ProductRow>; histories: HistoryRow[] } | null = null;
let txLock: Promise<unknown> = Promise.resolve();

/** findUnique の応答を任意のタイミングまで保留する（同時実行の再現用）。読み取り自体は呼び出し時点で行う */
let holdReads = false;
const heldReads: Array<() => void> = [];

function seedProducts(rows: ProductRow[]) {
  db.products = new Map(rows.map((row) => [row.id, { soldAt: null, updatedById: null, ...row }]));
}

function installDb() {
  db.products = new Map();
  db.histories = [];
  db.failHistoryCreate = false;
  working = null;
  txLock = Promise.resolve();
  holdReads = false;
  heldReads.length = 0;

  mockedFindUnique.mockImplementation((async (args: { where: { id?: string; shopId?: string } }) => {
    const { id, shopId } = args.where;
    const row = [...db.products.values()].find((p) => p.id === id && (shopId === undefined || p.shopId === shopId));
    const snapshot = row ? { ...row } : null;
    if (holdReads) await new Promise<void>((resolve) => heldReads.push(resolve));
    return snapshot;
  }) as never);

  tx.product.updateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Partial<ProductRow> }) => {
    let count = 0;
    for (const row of working!.products.values()) {
      if (Object.entries(args.where).every(([key, value]) => row[key as keyof ProductRow] === value)) {
        Object.assign(row, args.data);
        count += 1;
      }
    }
    return { count };
  });

  tx.productHistory.create.mockImplementation(async (args: { data: HistoryRow }) => {
    if (db.failHistoryCreate) throw new Error("history insert failed");
    working!.histories.push(args.data);
    return { id: `history-${working!.histories.length}` };
  });

  mockedTransaction.mockImplementation((async (fn: unknown) => {
    if (typeof fn !== "function") throw new Error("このテストは interactive transaction のみ再現する");
    const run = async () => {
      working = {
        products: new Map([...db.products].map(([id, row]) => [id, { ...row }])),
        histories: [...db.histories],
      };
      try {
        const result = await fn(tx);
        db.products = working.products;
        db.histories = working.histories;
        return result;
      } finally {
        working = null;
      }
    };
    const next = txLock.then(run, run);
    txLock = next.catch(() => undefined);
    return next;
  }) as never);
}

function product(id: string) {
  return db.products.get(id)!;
}

function productRecord(target: typeof PRODUCT_A | typeof PRODUCT_B, status: "ACTIVE" | "SOLD" = "ACTIVE"): ProductRow {
  return { id: target.id, shopId: target.shopId, productCode: target.productCode, status };
}

/** 両店舗の商品が存在するDB */
function seedBothShops(statusA: "ACTIVE" | "SOLD" = "ACTIVE") {
  seedProducts([productRecord(PRODUCT_A, statusA), productRecord(PRODUCT_B)]);
}

function expectNoWrites() {
  expect(mockedTransaction).not.toHaveBeenCalled();
  for (const mock of [
    prisma.product.update,
    prisma.product.updateMany,
    prisma.productHistory.create,
    prisma.priceHistory.create,
    tx.product.update,
    tx.product.updateMany,
    tx.productHistory.create,
    tx.priceHistory.create,
  ]) {
    expect(mock).not.toHaveBeenCalled();
  }
  expect(db.histories).toHaveLength(0);
}

/** 保留中の非同期処理を進める */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockReset();
  mockedAuthContext.mockReset();
  mockedUserFindUnique.mockReset();
  mockedFindUnique.mockReset();
  installDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("markProductAsSold", () => {
  it("未認証の場合はエラーを返す", async () => {
    denyAuth("UNAUTHENTICATED");

    const result = await markProductAsSold("product-1");

    expect(result.error).toBeDefined();
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("他店舗の商品は操作できない", async () => {
    signInAs(SESSION);
    seedProducts([{ id: "product-1", shopId: "other-shop", status: "ACTIVE" }]);

    const result = await markProductAsSold("product-1");

    expect(result.error).toBeDefined();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("すでにSOLDの商品は再度SOLDにできない", async () => {
    signInAs(SESSION);
    seedProducts([{ id: "product-1", shopId: "shop-1", status: "SOLD" }]);

    const result = await markProductAsSold("product-1");

    expect(result.error).toBeDefined();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("自店舗のACTIVE商品はSOLDへ遷移できる", async () => {
    signInAs(SESSION);
    seedProducts([{ id: "product-1", shopId: "shop-1", status: "ACTIVE" }]);

    const result = await markProductAsSold("product-1");

    expect(result.success).toBeDefined();
    expect(mockedTransaction).toHaveBeenCalledTimes(1);
    expect(product("product-1").status).toBe("SOLD");
  });
});

describe("markProductAsSold: 店舗間の認可（双方向）", () => {
  it("ケースA: 店舗Aのユーザーは店舗Aの商品をSOLDにでき、更新・履歴は店舗Aの商品だけに作られる", async () => {
    signInAs(SESSION_A);
    seedBothShops();

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual({ success: "商品を販売済みにしました。" });
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { id: PRODUCT_A.id, shopId: SHOP_A.id } });
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: PRODUCT_A.id, shopId: SHOP_A.id },
      data: { status: "SOLD", updatedById: USER_A.id },
    });
    expect(tx.productHistory.create).toHaveBeenCalledTimes(1);
    expect(tx.productHistory.create.mock.calls[0][0]).toEqual({
      data: {
        productId: PRODUCT_A.id,
        action: "STATUS_CHANGE",
        changedById: USER_A.id,
        oldValue: { status: "ACTIVE" },
        newValue: { status: "SOLD" },
      },
    });
    // SOLD変更は価格を変えないため価格履歴は作らない
    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
    expect(tx.priceHistory.create).not.toHaveBeenCalled();
    // トランザクション外での更新・履歴作成は行わない
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.productHistory.create).not.toHaveBeenCalled();
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "SOLD", updatedById: USER_A.id });
    expect(product(PRODUCT_A.id).soldAt).toBeInstanceOf(Date);
    expect(product(PRODUCT_B.id)).toMatchObject({ status: "ACTIVE", soldAt: null });
  });

  it("ケースB: 店舗Aのユーザーが店舗Bの商品IDを指定すると拒否され、副作用がない", async () => {
    signInAs(SESSION_A);
    seedBothShops();

    const result = await markProductAsSold(PRODUCT_B.id);

    expect(result).toEqual(NOT_FOUND);
    // F-06: 取得条件にセッション（店舗A）のshopIdが含まれ、店舗Bの商品はDB取得の時点でnullになる
    expect(mockedFindUnique).toHaveBeenCalledTimes(1);
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { id: PRODUCT_B.id, shopId: SHOP_A.id } });
    await expect(mockedFindUnique.mock.results[0].value).resolves.toBeNull();
    expectNoWrites();
    expect(product(PRODUCT_B.id)).toMatchObject({ status: "ACTIVE", soldAt: null });
  });

  it("ケースC: 店舗Bのユーザーが店舗Aの商品IDを指定すると拒否され、副作用がない", async () => {
    signInAs(SESSION_B);
    seedBothShops();

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual(NOT_FOUND);
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { id: PRODUCT_A.id, shopId: SHOP_B.id } });
    await expect(mockedFindUnique.mock.results[0].value).resolves.toBeNull();
    expectNoWrites();
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "ACTIVE", soldAt: null });
  });

  it("ケースD: 未ログインでは商品を検索せず拒否され、副作用がない", async () => {
    denyAuth("UNAUTHENTICATED");
    seedBothShops();

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(mockedFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(["USER_NOT_FOUND", "SHOP_INACTIVE"] as const)("ケースD': DB照合が %s なら拒否され、副作用がない", async (reason) => {
    denyAuth(reason);

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(mockedFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("ケースE: 存在しない商品IDは拒否され、副作用がない", async () => {
    signInAs(SESSION_A);
    seedBothShops();

    const result = await markProductAsSold(MISSING_ID);

    expect(result).toEqual(NOT_FOUND);
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { id: MISSING_ID, shopId: SHOP_A.id } });
    expectNoWrites();
  });

  it("他店舗の商品と存在しない商品で応答が同一（存在を推測できない）", async () => {
    signInAs(SESSION_A);
    seedBothShops();

    const otherShop = await markProductAsSold(PRODUCT_B.id);
    const missing = await markProductAsSold(MISSING_ID);

    expect(otherShop).toEqual(missing);
    expect(otherShop).toEqual(NOT_FOUND);
  });

  it("多層防御: 取得結果に他店舗の商品が混入しても、shopId照合で拒否され副作用がない", async () => {
    // 取得条件が将来誤って緩められた場合を想定し、DB層がshopIdを無視して返すケースを再現する
    signInAs(SESSION_A);
    mockedFindUnique.mockResolvedValue(productRecord(PRODUCT_B) as never);

    const result = await markProductAsSold(PRODUCT_B.id);

    expect(result).toEqual(NOT_FOUND);
    expectNoWrites();
  });

  it("ケースF: すでにSOLDの自店商品は更新も履歴追加もされない", async () => {
    signInAs(SESSION_A);
    seedBothShops("SOLD");

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual(NOT_ACTIVE);
    expectNoWrites();
  });

  it("店舗Bでも同じ規則: 自店の商品だけ更新され、店舗Aの商品には触れない", async () => {
    signInAs(SESSION_B);
    seedBothShops();

    const result = await markProductAsSold(PRODUCT_B.id);

    expect(result.success).toBeDefined();
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { id: PRODUCT_B.id, shopId: SHOP_B.id } });
    expect(tx.product.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: PRODUCT_B.id, shopId: SHOP_B.id } });
    expect(tx.productHistory.create.mock.calls[0][0]).toMatchObject({ data: { productId: PRODUCT_B.id, changedById: USER_B.id } });
    const touched = JSON.stringify([...tx.product.updateMany.mock.calls, ...tx.productHistory.create.mock.calls]);
    expect(touched.includes(PRODUCT_A.id) || touched.includes(SHOP_A.id)).toBe(false);
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "ACTIVE", soldAt: null });
  });
});

describe("markProductAsSold: 条件付き更新（F-05）", () => {
  it("更新条件に id・セッションのshopId・status: ACTIVE がすべて含まれる", async () => {
    signInAs(SESSION_A);
    seedBothShops();

    await markProductAsSold(PRODUCT_A.id);

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: PRODUCT_A.id, shopId: SHOP_A.id, status: "ACTIVE" },
      data: { status: "SOLD", soldAt: expect.any(Date), updatedById: USER_A.id },
    });
  });

  it("更新件数が1件のときだけ履歴を1件作成する", async () => {
    signInAs(SESSION_A);
    seedBothShops();

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result.success).toBeDefined();
    await expect(tx.product.updateMany.mock.results[0].value).resolves.toEqual({ count: 1 });
    expect(tx.productHistory.create).toHaveBeenCalledTimes(1);
    expect(db.histories).toHaveLength(1);
  });

  it("事前確認後にSOLDへ変わっていた（更新件数0件）場合は履歴を作らず、SOLD済みと同じ拒否結果を返す", async () => {
    signInAs(SESSION_A);
    seedBothShops();
    const soldEarlier = new Date("2026-10-01T00:00:00Z");
    // 事前確認（findUnique）ではACTIVEを返すが、更新時点では別リクエストがSOLDにしている状態
    mockedFindUnique.mockResolvedValueOnce(productRecord(PRODUCT_A) as never);
    Object.assign(product(PRODUCT_A.id), { status: "SOLD", soldAt: soldEarlier, updatedById: USER_B.id });

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual(NOT_ACTIVE);
    await expect(tx.product.updateMany.mock.results[0].value).resolves.toEqual({ count: 0 });
    expect(tx.productHistory.create).not.toHaveBeenCalled();
    expect(db.histories).toHaveLength(0);
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "SOLD", soldAt: soldEarlier, updatedById: USER_B.id });
  });

  it("更新件数が想定外（2件以上）の場合も履歴を作らず拒否し、更新はrollbackされる", async () => {
    signInAs(SESSION_A);
    seedBothShops();
    tx.product.updateMany.mockImplementationOnce(async (args: { data: Partial<ProductRow> }) => {
      Object.assign(working!.products.get(PRODUCT_A.id)!, args.data);
      return { count: 2 };
    });

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual(NOT_ACTIVE);
    expect(tx.productHistory.create).not.toHaveBeenCalled();
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "ACTIVE", soldAt: null });
  });

  it("ProductHistoryの作成に失敗するとトランザクション全体が失敗し、商品はACTIVEのまま残る", async () => {
    signInAs(SESSION_A);
    seedBothShops();
    db.failHistoryCreate = true;

    await expect(markProductAsSold(PRODUCT_A.id)).rejects.toThrow("history insert failed");

    // updateMany は実行されたが、commitされていない
    await expect(tx.product.updateMany.mock.results[0].value).resolves.toEqual({ count: 1 });
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "ACTIVE", soldAt: null, updatedById: null });
    expect(db.histories).toHaveLength(0);
  });

  it("PriceHistoryは作成しない", async () => {
    signInAs(SESSION_A);
    seedBothShops();

    await markProductAsSold(PRODUCT_A.id);

    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
    expect(tx.priceHistory.create).not.toHaveBeenCalled();
  });
});

describe("markProductAsSold: 同時実行（F-05、モック上の再現）", () => {
  it("Promise.allで並行した2つのSOLD変更は、両方がACTIVEを確認しても成功は1回・履歴は1件だけ", async () => {
    signInAs(SESSION_A);
    seedBothShops();
    holdReads = true;

    const requests = Promise.all([markProductAsSold(PRODUCT_A.id), markProductAsSold(PRODUCT_A.id)]);
    await flush();
    // 両方のリクエストが事前確認でACTIVEを読み取った状態で、同時に処理を進める
    expect(heldReads).toHaveLength(2);
    heldReads.forEach((release) => release());
    const results = await requests;

    for (const read of mockedFindUnique.mock.results) await expect(read.value).resolves.toMatchObject({ status: "ACTIVE" });
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toEqual([NOT_ACTIVE]);
    expect(tx.product.updateMany).toHaveBeenCalledTimes(2);
    const counts = await Promise.all(tx.product.updateMany.mock.results.map((r) => r.value));
    expect(counts).toEqual([{ count: 1 }, { count: 0 }]);
    expect(tx.productHistory.create).toHaveBeenCalledTimes(1);
    expect(db.histories).toEqual([
      {
        productId: PRODUCT_A.id,
        action: "STATUS_CHANGE",
        changedById: USER_A.id,
        oldValue: { status: "ACTIVE" },
        newValue: { status: "SOLD" },
      },
    ]);
    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
    expect(tx.priceHistory.create).not.toHaveBeenCalled();
  });

  it("後続リクエストは別の時刻でsoldAtを生成しても、先行リクエストのsoldAtを上書きしない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = new Date("2026-10-17T01:00:00.000Z");
    const second = new Date("2026-10-17T01:00:05.000Z");
    signInAs(SESSION_A);
    seedBothShops();
    holdReads = true;

    const requestA = markProductAsSold(PRODUCT_A.id);
    const requestB = markProductAsSold(PRODUCT_A.id);
    await flush();
    expect(heldReads).toHaveLength(2);

    // A: 時刻firstでsoldAtを生成してトランザクションへ
    vi.setSystemTime(first);
    heldReads[0]();
    await flush();
    // B: 時刻secondでsoldAtを生成してトランザクションへ（A完了前に進むこともある）
    vi.setSystemTime(second);
    heldReads[1]();

    const [resultA, resultB] = await Promise.all([requestA, requestB]);

    expect(resultA.success).toBeDefined();
    expect(resultB).toEqual(NOT_ACTIVE);
    // Bも second を付けて更新を試みたが、条件に一致せず反映されない
    expect(tx.product.updateMany.mock.calls[1][0].data.soldAt).toEqual(second);
    expect(product(PRODUCT_A.id).soldAt).toEqual(first);
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "SOLD", updatedById: USER_A.id });
    expect(db.histories).toHaveLength(1);
  });

  it("他店舗のユーザーが同時にSOLD変更しても、自店の1回だけが成功し他店舗の要求は何も書き込まない", async () => {
    signInOnceAs(SESSION_A);
    signInOnceAs(SESSION_B);
    seedBothShops();
    holdReads = true;

    const requests = Promise.all([markProductAsSold(PRODUCT_A.id), markProductAsSold(PRODUCT_A.id)]);
    await flush();
    heldReads.forEach((release) => release());
    const [own, other] = await requests;

    expect(own.success).toBeDefined();
    expect(other).toEqual(NOT_FOUND);
    expect(mockedTransaction).toHaveBeenCalledTimes(1);
    expect(db.histories).toHaveLength(1);
    expect(db.histories[0].changedById).toBe(USER_A.id);
  });
});

describe("markProductAsSold: DB由来の認可コンテキスト（F-01-C）", () => {
  it("DB上の所属が店舗Bなら、JWTの店舗Aではなく店舗Bのスコープで処理し、店舗Aの商品は見つからない", async () => {
    seedBothShops();
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "STORE" } });

    const former = await markProductAsSold(PRODUCT_A.id);
    const own = await markProductAsSold(PRODUCT_B.id);

    expect(former).toEqual(NOT_FOUND);
    expect(mockedFindUnique).toHaveBeenCalledWith({ where: { id: PRODUCT_A.id, shopId: SHOP_B.id } });
    expect(own).toEqual({ success: "商品を販売済みにしました。" });
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: PRODUCT_B.id, shopId: SHOP_B.id, status: "ACTIVE" },
      data: { status: "SOLD", updatedById: USER_A.id },
    });
    expect(tx.productHistory.create.mock.calls[0][0].data.changedById).toBe(USER_A.id);
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "ACTIVE", soldAt: null });
  });

  it("DB上のロールがSTORE（JWTはADMIN）でも、ロールに依存しない既存の処理はDB由来の値で進む", async () => {
    seedBothShops();
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_A.id, role: "STORE" } });

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result.success).toBeDefined();
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "SOLD", updatedById: USER_A.id });
  });

  it("実際の認可ヘルパー経由: JWTは店舗A・ADMIN、DBは店舗B・STOREなら店舗Bで処理する", async () => {
    seedBothShops();
    useRealAuthContext(SESSION_A, { id: USER_A.id, shopId: SHOP_B.id, role: "STORE", shop: { isActive: true } });

    const former = await markProductAsSold(PRODUCT_A.id);
    const own = await markProductAsSold(PRODUCT_B.id);

    expect(former).toEqual(NOT_FOUND);
    expect(own.success).toBeDefined();
    expect(mockedUserFindUnique.mock.calls[0][0]).toMatchObject({ where: { id: USER_A.id } });
    expect(tx.product.updateMany.mock.calls[0][0].where).toEqual({ id: PRODUCT_B.id, shopId: SHOP_B.id, status: "ACTIVE" });
    expect(JSON.stringify(tx.product.updateMany.mock.calls)).not.toContain(SHOP_A.id);
  });

  it.each([
    ["店舗が無効", { id: USER_A.id, shopId: SHOP_A.id, role: "ADMIN", shop: { isActive: false } }],
    ["ユーザーが削除済み", null],
  ])("実際の認可ヘルパー経由: DB上で%sなら、JWTが有効でも拒否し、商品を検索せず書き込まない", async (_label, dbUser) => {
    seedBothShops();
    useRealAuthContext(SESSION_A, dbUser);

    const result = await markProductAsSold(PRODUCT_A.id);

    expect(result).toEqual({ error: "認証が必要です。" });
    expect(mockedFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
    expect(product(PRODUCT_A.id)).toMatchObject({ status: "ACTIVE", soldAt: null });
  });

  it("getAuthContext() が例外（DB障害など）なら伝播し、古いJWTで処理を続けない", async () => {
    seedBothShops();
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedAuthContext.mockRejectedValue(new Error("db down"));

    await expect(markProductAsSold(PRODUCT_A.id)).rejects.toThrow("db down");
    expect(mockedFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("入口で getAuthContext() を1回だけ呼び、auth() を直接呼ばない", async () => {
    seedBothShops();
    signInAs(SESSION_A);

    await markProductAsSold(PRODUCT_A.id);

    expect(mockedAuthContext).toHaveBeenCalledTimes(1);
    expect(mockedAuth).not.toHaveBeenCalled();
  });
});
