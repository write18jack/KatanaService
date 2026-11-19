import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SESSION_A, SHOP_A, SHOP_B, USER_A } from "@/lib/testing/tenantFixtures";
import { getAuthContext, hasRole, type AuthContext } from "./context";

type AuthMock = (...args: never[]) => Promise<unknown>;
const mockedAuth = auth as unknown as ReturnType<typeof vi.fn<AuthMock>>;
const mockedFindUnique = vi.mocked(prisma.user.findUnique);

type UserRow = { id: string; name: string; email: string; password: string; role: "ADMIN" | "STORE"; shopId: string };

/** 仮想データ（実DBには接続しない）: 店舗Aは有効、店舗Bは無効 */
let shops: Record<string, { isActive: boolean } | undefined>;
let users: UserRow[];

function dbUser(overrides: Partial<UserRow> = {}): UserRow {
  return { id: USER_A.id, name: USER_A.name, email: "a@example.test", password: "hash:secret", role: "ADMIN", shopId: SHOP_A.id, ...overrides };
}

/** where.id で検索し、select で要求された項目だけを返す簡易DB */
function installDb() {
  mockedFindUnique.mockImplementation((async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
    const user = users.find((u) => u.id === args.where.id);
    if (!user) return null;
    if (!args.select) return { ...user };
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.select)) {
      if (!value) continue;
      if (key === "shop") {
        const shop = shops[user.shopId];
        result.shop = shop ? { isActive: shop.isActive } : null;
      } else {
        result[key] = user[key as keyof UserRow];
      }
    }
    return result;
  }) as never);
}

/** ログイン時点の shopId / role がJWTに残っているセッション */
function staleSession(shopId: string, role: "ADMIN" | "STORE") {
  return { ...SESSION_A, user: { ...SESSION_A.user, shopId, role } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockReset();
  mockedFindUnique.mockReset();
  shops = { [SHOP_A.id]: { isActive: true }, [SHOP_B.id]: { isActive: false } };
  users = [dbUser()];
  installDb();
});

describe("getAuthContext: 未認証", () => {
  it("1/17: 未ログインは UNAUTHENTICATED で、DBに問い合わせない", async () => {
    mockedAuth.mockResolvedValue(null);

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "UNAUTHENTICATED" });
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["user がない", { expires: SESSION_A.expires }],
    ["user.id がない", { ...SESSION_A, user: { ...SESSION_A.user, id: undefined } }],
    ["user.id が空文字", { ...SESSION_A, user: { ...SESSION_A.user, id: "" } }],
  ])("2: セッションに %s 場合は UNAUTHENTICATED で、DBに問い合わせない", async (_label, session) => {
    mockedAuth.mockResolvedValue(session);

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "UNAUTHENTICATED" });
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("2': shopId・roleだけが残っていて user.id がないセッションも UNAUTHENTICATED", async () => {
    mockedAuth.mockResolvedValue({ user: { shopId: SHOP_A.id, role: "ADMIN" }, expires: SESSION_A.expires });

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "UNAUTHENTICATED" });
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });
});

describe("getAuthContext: DB照合", () => {
  it("3/12/13: 有効店舗のユーザーはDB由来のcontextを返し、IDで検索・必要な項目だけを取得する", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    const result = await getAuthContext();

    expect(result).toEqual({ ok: true, context: { userId: USER_A.id, shopId: SHOP_A.id, role: "ADMIN" } });
    expect(mockedFindUnique).toHaveBeenCalledTimes(1);
    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { id: USER_A.id },
      select: { id: true, shopId: true, role: true, shop: { select: { isActive: true } } },
    });
  });

  it("13: DBが余分な項目を返しても、contextには userId・shopId・role 以外を含めない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValueOnce({ ...dbUser(), shop: { isActive: true } } as never);

    const result = await getAuthContext();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.context).sort()).toEqual(["role", "shopId", "userId"]);
    expect(JSON.stringify(result)).not.toContain("hash:secret");
    expect(JSON.stringify(result)).not.toContain("a@example.test");
  });

  it("4: セッションのIDに対応するUserがDBにない（削除済み）場合は USER_NOT_FOUND", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    users = [];

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "USER_NOT_FOUND" });
  });

  it("5: Shop.isActive=false は SHOP_INACTIVE", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    shops[SHOP_A.id] = { isActive: false };

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "SHOP_INACTIVE" });
  });

  it("6: Shopが取得できない場合は安全側に倒して SHOP_INACTIVE", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    shops[SHOP_A.id] = undefined;

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "SHOP_INACTIVE" });
  });

  it.each([
    ["undefined", { shop: {} }],
    ["null", { shop: { isActive: null } }],
    ["文字列 'true'", { shop: { isActive: "true" } }],
    ["数値 1", { shop: { isActive: 1 } }],
  ])("16: Shop.isActive が %s（true以外）なら SHOP_INACTIVE", async (_label, extra) => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockResolvedValueOnce({ id: USER_A.id, shopId: SHOP_A.id, role: "ADMIN", ...extra } as never);

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "SHOP_INACTIVE" });
  });
});

describe("getAuthContext: JWTの古い認可情報を使わない", () => {
  it("7: JWTのshopId=A、DBのshopId=B（有効）なら B を返す", async () => {
    shops[SHOP_B.id] = { isActive: true };
    users = [dbUser({ shopId: SHOP_B.id })];
    mockedAuth.mockResolvedValue(staleSession(SHOP_A.id, "ADMIN"));

    const result = await getAuthContext();

    expect(result).toEqual({ ok: true, context: { userId: USER_A.id, shopId: SHOP_B.id, role: "ADMIN" } });
  });

  it("7': JWTのshopId=A（有効）、DBで無効な店舗Bへ所属変更済みなら SHOP_INACTIVE（JWTの有効な店舗で許可しない）", async () => {
    users = [dbUser({ shopId: SHOP_B.id })];
    mockedAuth.mockResolvedValue(staleSession(SHOP_A.id, "ADMIN"));

    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "SHOP_INACTIVE" });
  });

  it("8: JWTのrole=ADMIN、DBで STORE に降格済みなら STORE を返す", async () => {
    users = [dbUser({ role: "STORE" })];
    mockedAuth.mockResolvedValue(staleSession(SHOP_A.id, "ADMIN"));

    const result = await getAuthContext();

    expect(result).toEqual({ ok: true, context: { userId: USER_A.id, shopId: SHOP_A.id, role: "STORE" } });
  });

  it("9: JWTのrole=STORE、DBで ADMIN に昇格済みなら ADMIN を返す", async () => {
    users = [dbUser({ role: "ADMIN" })];
    mockedAuth.mockResolvedValue(staleSession(SHOP_A.id, "STORE"));

    const result = await getAuthContext();

    expect(result.ok && result.context.role).toBe("ADMIN");
  });

  it("18: DB照合にJWTの shopId・role を使わない（検索条件はIDだけ）", async () => {
    shops[SHOP_B.id] = { isActive: true };
    users = [dbUser({ shopId: SHOP_B.id, role: "STORE" })];
    mockedAuth.mockResolvedValue(staleSession(SHOP_A.id, "ADMIN"));

    const result = await getAuthContext();

    const query = JSON.stringify(mockedFindUnique.mock.calls[0][0]);
    expect(query).not.toContain(SHOP_A.id);
    expect(query).not.toContain('"ADMIN"');
    expect(mockedFindUnique.mock.calls[0][0]).toMatchObject({ where: { id: USER_A.id } });
    expect(JSON.stringify(result)).not.toContain(SHOP_A.id);
    expect(result.ok && result.context.role).toBe("STORE");
  });
});

describe("getAuthContext: 障害時（fail-closed）", () => {
  it("10: DB取得で例外が起きたら伝播させ、認可成功を返さない", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);
    mockedFindUnique.mockRejectedValueOnce(new Error("connection refused"));

    await expect(getAuthContext()).rejects.toThrow("connection refused");
  });

  it("11: auth() で例外が起きたら伝播させ、DBに問い合わせない", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("JWT decode failed"));

    await expect(getAuthContext()).rejects.toThrow("JWT decode failed");
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("呼び出しごとにDBの最新状態で判定する（テスト環境のcacheは結果を保持しない）", async () => {
    mockedAuth.mockResolvedValue(SESSION_A);

    await expect(getAuthContext()).resolves.toMatchObject({ ok: true });
    shops[SHOP_A.id] = { isActive: false };
    await expect(getAuthContext()).resolves.toEqual({ ok: false, reason: "SHOP_INACTIVE" });
    expect(mockedFindUnique).toHaveBeenCalledTimes(2);
  });
});

describe("hasRole", () => {
  const context: AuthContext = { userId: USER_A.id, shopId: SHOP_A.id, role: "STORE" };

  it("14: ロールが一致すれば true", () => {
    expect(hasRole(context, "STORE")).toBe(true);
  });

  it("15: ロールが一致しなければ false（ADMINがSTOREを包含するような階層は定義しない）", () => {
    expect(hasRole(context, "ADMIN")).toBe(false);
    expect(hasRole({ ...context, role: "ADMIN" }, "STORE")).toBe(false);
  });
});
