import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn(async () => "hashed-password") },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    shop: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { registerUser } from "./register";

const VALID_INPUT = {
  shopName: "テスト店舗",
  name: "担当者",
  email: "owner@example.com",
  password: "password-123",
};

beforeEach(() => {
  vi.clearAllMocks();
});

function expectNoSideEffects() {
  expect(prisma.user.findUnique).not.toHaveBeenCalled();
  expect(prisma.user.create).not.toHaveBeenCalled();
  expect(prisma.shop.create).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(bcrypt.hash).not.toHaveBeenCalled();
}

describe("registerUser（自己登録は停止中）", () => {
  it("正しい入力でも、何も作らずにエラーを返す", async () => {
    const call = registerUser as unknown as (v: unknown) => Promise<unknown>;
    const result = await call(VALID_INPUT);

    expect(result).toEqual({ error: "現在、新規登録は受け付けていません。" });
    expect(result).not.toHaveProperty("success");
    expectNoSideEffects();
  });

  it("role: ADMIN を混ぜて直接呼ばれても、何も作らない", async () => {
    const call = registerUser as unknown as (v: unknown) => Promise<unknown>;
    const result = await call({ ...VALID_INPUT, role: "ADMIN" });

    expect(result).toEqual({ error: "現在、新規登録は受け付けていません。" });
    expectNoSideEffects();
  });

  it("引数なしでも、同じエラーを返す", async () => {
    await expect(registerUser()).resolves.toEqual({
      error: "現在、新規登録は受け付けていません。",
    });
    expectNoSideEffects();
  });
});
