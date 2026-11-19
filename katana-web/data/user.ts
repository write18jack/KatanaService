import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export const getUserFromDb = async (email: string, password: string) => {
  // 1. email で検索（unique）。所属店舗の有効状態も同時に取得する
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      shop: {
        select: { isActive: true },
      },
    },
  });

  if (!user) return null;

  // 2. パスワードチェックの修正
  // 直接比較 (!==) ではなく、bcrypt.compare を使用する
  const isPasswordMatch = await bcrypt.compare(password, user.password);

  if (!isPasswordMatch) return null;

  // 3. 無効店舗（または店舗が取得できない）のユーザーはログインさせない。
  // 外向きにはパスワード不一致と区別しない（null を返す）
  if (user.shop?.isActive !== true) return null;

  // 4. Auth.js に返す user は「安全なフィールドだけ」
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    shopId: user.shopId,
  };
};
