import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn() },
}));

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getUserFromDb } from "./user";

const mockedFindUnique = vi.mocked(prisma.user.findUnique);
const mockedCompare = vi.mocked(bcrypt.compare) as unknown as ReturnType<typeof vi.fn<(plain: string, hash: string) => Promise<boolean>>>;

/** 仮想データ（実DBには接続しない）: 店舗Aは有効、店舗Bは無効 */
const SHOPS: Record<string, { isActive: boolean }> = {
  "shop-avocado": { isActive: true },
  "shop-hikouyoku": { isActive: false },
};

const PASSWORD = "correct-password";

type UserRow = { id: string; name: string; email: string; password: string; role: "ADMIN" | "STORE"; shopId: string };

const USER_ACTIVE: UserRow = {
  id: "user-avocado",
  name: "テストユーザーA",
  email: "a@example.test",
  password: `hash:${PASSWORD}`,
  role: "ADMIN",
  shopId: "shop-avocado",
};
const USER_INACTIVE: UserRow = { ...USER_ACTIVE, id: "user-hikouyoku", name: "テストユーザーB", email: "b@example.test", shopId: "shop-hikouyoku" };
const USER_NO_SHOP: UserRow = { ...USER_ACTIVE, id: "user-orphan", name: "店舗なし", email: "orphan@example.test", shopId: "shop-missing" };

const USERS = [USER_ACTIVE, USER_INACTIVE, USER_NO_SHOP];

/** where.email で検索し、include.shop が要求されたときだけ店舗（select: isActive）を付ける簡易DB */
function installDb() {
  mockedFindUnique.mockImplementation((async (args: { where: { email?: string }; include?: { shop?: unknown } }) => {
    const user = USERS.find((u) => u.email === args.where.email);
    if (!user) return null;
    if (!args.include?.shop) return { ...user };
    const shop = SHOPS[user.shopId];
    return { ...user, shop: shop ? { isActive: shop.isActive } : null };
  }) as never);
  mockedCompare.mockImplementation(async (plain, hash) => hash === `hash:${plain}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindUnique.mockReset();
  mockedCompare.mockReset();
  installDb();
});

describe("getUserFromDb: 店舗の有効性（F-01-A）", () => {
  it("1/9: 有効店舗＋正しいパスワードは認証成功し、従来どおりのフィールドだけを返す", async () => {
    const result = await getUserFromDb(USER_ACTIVE.email, PASSWORD);

    expect(result).toEqual({
      id: USER_ACTIVE.id,
      name: USER_ACTIVE.name,
      email: USER_ACTIVE.email,
      role: USER_ACTIVE.role,
      shopId: USER_ACTIVE.shopId,
    });
    // パスワードハッシュや店舗情報を含めない
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("shop");
    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { email: USER_ACTIVE.email },
      include: { shop: { select: { isActive: true } } },
    });
    expect(mockedCompare).toHaveBeenCalledWith(PASSWORD, USER_ACTIVE.password);
  });

  it("2/10: 無効店舗＋正しいパスワードでも null（JWTに渡すユーザー情報を返さない）", async () => {
    const result = await getUserFromDb(USER_INACTIVE.email, PASSWORD);

    expect(result).toBeNull();
    // パスワード検証は省略せずに行ったうえで拒否している
    expect(mockedCompare).toHaveBeenCalledWith(PASSWORD, USER_INACTIVE.password);
    await expect(mockedCompare.mock.results[0].value).resolves.toBe(true);
  });

  it("3: 有効店舗＋誤ったパスワードは null", async () => {
    await expect(getUserFromDb(USER_ACTIVE.email, "wrong-password")).resolves.toBeNull();
  });

  it("4: 無効店舗＋誤ったパスワードは null", async () => {
    await expect(getUserFromDb(USER_INACTIVE.email, "wrong-password")).resolves.toBeNull();
  });

  it("5: 存在しないユーザーは null（既存どおりパスワード検証は行わない）", async () => {
    await expect(getUserFromDb("nobody@example.test", PASSWORD)).resolves.toBeNull();
    expect(mockedCompare).not.toHaveBeenCalled();
  });

  it("6: 所属店舗が取得できない状態は認証拒否", async () => {
    await expect(getUserFromDb(USER_NO_SHOP.email, PASSWORD)).resolves.toBeNull();
  });

  it("無効店舗・パスワード不一致・ユーザー不存在で、戻り値は区別できない（すべて null）", async () => {
    const results = await Promise.all([
      getUserFromDb(USER_INACTIVE.email, PASSWORD),
      getUserFromDb(USER_ACTIVE.email, "wrong-password"),
      getUserFromDb("nobody@example.test", PASSWORD),
    ]);

    expect(results).toEqual([null, null, null]);
  });

  it("7: DB取得が失敗した場合は既存どおり例外を投げ、認証を成功させない", async () => {
    mockedFindUnique.mockRejectedValueOnce(new Error("connection refused"));

    await expect(getUserFromDb(USER_ACTIVE.email, PASSWORD)).rejects.toThrow("connection refused");
    expect(mockedCompare).not.toHaveBeenCalled();
  });

  it("8: bcryptが例外を投げた場合は既存どおり例外を投げ、認証を成功させない", async () => {
    mockedCompare.mockRejectedValueOnce(new Error("bcrypt failure"));

    await expect(getUserFromDb(USER_ACTIVE.email, PASSWORD)).rejects.toThrow("bcrypt failure");
  });

  it("isActive が真偽値でない（未取得など）場合も認証成功にしない", async () => {
    mockedFindUnique.mockResolvedValueOnce({ ...USER_ACTIVE, shop: {} } as never);

    await expect(getUserFromDb(USER_ACTIVE.email, PASSWORD)).resolves.toBeNull();
  });
});
