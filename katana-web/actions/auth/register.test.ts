import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn(async () => "hashed-password") },
}));

const tx = {
  shop: { create: vi.fn() },
  user: { create: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { registerUser } from "./register";

const mockedFindUnique = vi.mocked(prisma.user.findUnique);
const mockedTransaction = vi.mocked(prisma.$transaction);

const VALID_INPUT = {
  shopName: "テスト店舗",
  name: "担当者",
  email: "owner@example.com",
  password: "password-123",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindUnique.mockResolvedValue(null);
  tx.shop.create.mockResolvedValue({ id: "shop-new" });
  tx.user.create.mockResolvedValue({ id: "user-new" });
  mockedTransaction.mockImplementation((async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) as never);
});

describe("registerUser", () => {
  it("自己登録で作るユーザーは STORE で、ADMIN にはならない", async () => {
    const result = await registerUser(VALID_INPUT);

    expect(result).toEqual({ success: expect.any(String) });
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.role).toBe(UserRole.STORE);
    expect(data.role).not.toBe(UserRole.ADMIN);
    expect(data.shopId).toBe("shop-new");
  });

  it("入力に role を混ぜても、STORE のまま作る", async () => {
    await registerUser({ ...VALID_INPUT, role: UserRole.ADMIN } as typeof VALID_INPUT);

    expect(tx.user.create.mock.calls[0][0].data.role).toBe(UserRole.STORE);
  });
});
