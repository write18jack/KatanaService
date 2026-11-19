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

const nav = vi.hoisted(() => {
  /** redirect() は例外で処理を打ち切る。テストでは遷移先を持つ例外として観測する */
  class RedirectSignal extends Error {
    constructor(
      readonly href: string,
      readonly locale: string,
    ) {
      super(`NEXT_REDIRECT:/${locale}${href}`);
    }
  }
  return { RedirectSignal };
});

vi.mock("next-intl/server", () => ({
  getLocale: async () => "ja",
}));

vi.mock("@/i18n/navigation", () => ({
  redirect: vi.fn(({ href, locale }: { href: string; locale: string }) => {
    throw new nav.RedirectSignal(href, locale);
  }),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// 認可はDB由来のコンテキストで行う。ページのテストでは結果をモックし、DB照合そのものは lib/auth/context.test.ts で検証する
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getAuthContext: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    importRow: { findMany: vi.fn(), update: vi.fn() },
  },
}));

import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { redirect } from "@/i18n/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { prisma } from "@/lib/prisma";
import { JOB_A, JOB_B, MISSING_ID, ROW_A, ROW_B, SESSION_A, SESSION_B, SHOP_A, SHOP_B, USER_A } from "@/lib/testing/tenantFixtures";
import ImportJobPage from "./page";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedFindUnique = vi.mocked(prisma.importJob.findUnique);
const mockedAuthContext = vi.mocked(getAuthContext);

type SessionLike = { user: { id: string; shopId: string; role: string } };

/** DB照合に成功した認可コンテキスト（DB上の値がセッションと一致している場合） */
function signInAs(session: SessionLike) {
  mockedAuthContext.mockResolvedValue({
    ok: true,
    context: { userId: session.user.id, shopId: session.user.shopId, role: session.user.role as UserRole },
  });
}

function denyAuth(reason: "UNAUTHENTICATED" | "USER_NOT_FOUND" | "SHOP_INACTIVE") {
  mockedAuthContext.mockResolvedValue({ ok: false, reason });
}

/** ページが redirect() した遷移先（/{locale}{href}） */
async function redirectTarget(render: Promise<unknown>) {
  const error = await render.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(nav.RedirectSignal);
  const signal = error as InstanceType<typeof nav.RedirectSignal>;
  return `/${signal.locale}${signal.href}`;
}

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

/**
 * 実DBと同じく where の id と shopId の両方を評価する簡易DB。
 * shopId条件に合わないジョブは（includeされる行ごと）null になる。
 */
function seedBothShopJobs() {
  const jobs = [jobRecord(JOB_A), jobRecord(JOB_B)] as Array<{ id: string; shopId: string }>;
  mockedFindUnique.mockImplementation((async (args: { where: { id?: string; shopId?: string } }) => {
    const { id, shopId } = args.where;
    return jobs.find((job) => job.id === id && (shopId === undefined || job.shopId === shopId)) ?? null;
  }) as never);
}

const INCLUDE_ROWS = { rows: { orderBy: { rowNumber: "asc" } } };

function render(jobId: string) {
  return ImportJobPage({ params: Promise.resolve({ jobId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindUnique.mockReset();
  mockedAuthContext.mockReset();
});

describe("ImportJob詳細ページ: 店舗間の認可", () => {
  it("ケースA: 店舗Aのユーザーは店舗Aのジョブを表示できる", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    const html = renderToStaticMarkup(await render(JOB_A.id));

    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { id: JOB_A.id, shopId: SHOP_A.id },
      include: INCLUDE_ROWS,
    });
    expect(html).toContain(JOB_A.fileName);
    expect(html).toContain(SECRETS[JOB_A.id].productCode);
    expect(html).toContain(SECRETS[JOB_A.id].message);
    expect(html).not.toContain(JOB_B.fileName);
  });

  it("店舗Bのユーザーは店舗Bのジョブを表示できる", async () => {
    signInAs(SESSION_B);
    seedBothShopJobs();

    const html = renderToStaticMarkup(await render(JOB_B.id));

    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { id: JOB_B.id, shopId: SHOP_B.id },
      include: INCLUDE_ROWS,
    });
    expect(html).toContain(JOB_B.fileName);
    expect(html).toContain(SECRETS[JOB_B.id].productCode);
    expect(html).toContain(SECRETS[JOB_B.id].message);
    expect(html).not.toContain(JOB_A.fileName);
  });

  it("rawData（取り込み原本）は自店のジョブでも画面に描画しない", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    const html = renderToStaticMarkup(await render(JOB_A.id));

    expect(html).not.toContain(SECRETS[JOB_A.id].raw);
  });

  it.each([
    ["ケースB: 店舗A → 店舗BのジョブID", SESSION_A, JOB_B],
    ["ケースC: 店舗B → 店舗AのジョブID", SESSION_B, JOB_A],
  ])("%s は notFound() になり、何も描画しない", async (_label, session, otherJob) => {
    signInAs(session);
    seedBothShopJobs();

    await expect(render(otherJob.id)).rejects.toBe(NOT_FOUND);
    // F-06: 取得条件はセッションのshopIdで絞られ、他店舗のジョブとImportRowはDB取得の時点でnullになる
    // （ファイル名・状態・件数・行・rawData・エラーメッセージのいずれも取得されない）
    expect(mockedFindUnique).toHaveBeenCalledTimes(1);
    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { id: otherJob.id, shopId: session.user.shopId },
      include: INCLUDE_ROWS,
    });
    expect(session.user.shopId).not.toBe(otherJob.shopId);
    await expect(mockedFindUnique.mock.results[0].value).resolves.toBeNull();
  });

  it("多層防御: 取得結果に他店舗のジョブが混入しても notFound() になる", async () => {
    // 取得条件が将来誤って緩められた場合を想定し、DB層がshopIdを無視して返すケースを再現する
    signInAs(SESSION_A);
    mockedFindUnique.mockResolvedValue(jobRecord(JOB_B));

    await expect(render(JOB_B.id)).rejects.toBe(NOT_FOUND);
  });

  it("ケースE: 存在しないジョブIDは notFound() になる", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    await expect(render(MISSING_ID)).rejects.toBe(NOT_FOUND);
    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { id: MISSING_ID, shopId: SHOP_A.id },
      include: INCLUDE_ROWS,
    });
  });

  it("他店舗のジョブと存在しないジョブで同じ応答になる（存在を推測できない）", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    const otherShop = await render(JOB_B.id).catch((error: unknown) => error);
    const missing = await render(MISSING_ID).catch((error: unknown) => error);

    expect(otherShop).toBe(NOT_FOUND);
    expect(missing).toBe(otherShop);
  });

  it("ケースD: 未ログインではジョブを検索せず、何も描画せずにログイン画面へ遷移する", async () => {
    // 通常はproxy.tsが先にログイン画面へ送る（proxy.test.tsで検証）。ページ単体でも取得前に打ち切る。
    denyAuth("UNAUTHENTICATED");

    await expect(redirectTarget(render(JOB_A.id))).resolves.toBe("/ja/login");

    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("このページはジョブや行を更新しない", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    await render(JOB_A.id);

    expect(prisma.importJob.update).not.toHaveBeenCalled();
    expect(prisma.importRow.update).not.toHaveBeenCalled();
  });
});

describe("ImportJob詳細ページ: DB由来の認可（F-01-D）", () => {
  it.each([
    ["無効店舗", "SHOP_INACTIVE"],
    ["削除済みユーザー", "USER_NOT_FOUND"],
  ] as const)("%sはジョブ・行を取得せず、アクセス停止画面へ遷移する", async (_label, reason) => {
    denyAuth(reason);
    seedBothShopJobs();

    await expect(redirectTarget(render(JOB_A.id))).resolves.toBe("/ja/access-suspended");

    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("DB上の所属が店舗Bなら、店舗Bのジョブを表示し、JWTの店舗Aのジョブは notFound() になる", async () => {
    seedBothShopJobs();
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "STORE" } });

    await expect(render(JOB_A.id)).rejects.toBe(NOT_FOUND);
    const html = renderToStaticMarkup(await render(JOB_B.id));

    expect(mockedFindUnique.mock.calls.map(([args]) => args.where)).toEqual([
      { id: JOB_A.id, shopId: SHOP_B.id },
      { id: JOB_B.id, shopId: SHOP_B.id },
    ]);
    expect(html).toContain(JOB_B.fileName);
    expect(html).not.toContain(JOB_A.fileName);
  });

  it("認可の確認（DB障害など）が例外なら、ジョブを取得せず、停止画面にも誘導しない", async () => {
    mockedAuthContext.mockRejectedValue(new Error("db down"));

    await expect(render(JOB_A.id)).rejects.toThrow("db down");

    expect(mockedFindUnique).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("ページは auth() を直接呼ばず、getAuthContext() で認可する", async () => {
    signInAs(SESSION_A);
    seedBothShopJobs();

    await render(JOB_A.id);

    expect(mockedAuthContext).toHaveBeenCalledTimes(1);
    expect(mockedAuth).not.toHaveBeenCalled();
  });
});
