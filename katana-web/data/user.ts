import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export const getUserFromDb = async (email: string, password: string) => {
  // 1. email で検索（unique）
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) return null;

  // 2. パスワードチェックの修正
  // 直接比較 (!==) ではなく、bcrypt.compare を使用する
  const isPasswordMatch = await bcrypt.compare(password, user.password);

  if (!isPasswordMatch) return null;

  // 3. Auth.js に返す user は「安全なフィールドだけ」
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    shopId: user.shopId,
  };
};
