import prisma from "@/lib/prisma";
import bcrypt from "bcryptjs";

export const getUserFromDb = async (name: string, password: string) => {
  try {
    // 1. name だけで検索（unique）
    const user = await prisma.user.findUnique({
      where: { name },
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
    };
  } catch (err) {
    throw err;
  }
};
