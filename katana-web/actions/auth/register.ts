"use server";

import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import {
  RegisterInput,
  registerSchema,
} from "@/actions/validation/auth-schema";
import { UserRole } from "@prisma/client";

export async function registerUser(values: RegisterInput) {
  // バリデーション
  const validatedFields = registerSchema.safeParse(values);

  if (!validatedFields.success) {
    return {
      error: "入力内容が正しくありません。",
    };
  }

  const { shopName, name, email, password } = validatedFields.data;

  try {
    // メールアドレス重複チェック
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return {
        error: "このメールアドレスは既に登録されています。",
      };
    }

    // パスワードハッシュ化
    const hashedPassword = await bcrypt.hash(password, 10);

    // Shop作成 + User作成
    await prisma.$transaction(async (tx) => {
      const shop = await tx.shop.create({
        data: {
          name: shopName,
          email,
        },
      });

      await tx.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          role: UserRole.ADMIN,
          shopId: shop.id,
        },
      });
    });

    return {
      success: "ユーザー登録が完了しました。ログインしてください。",
    };
  } catch (error) {
    console.error("Registration error:", error);

    return {
      error: "登録中にエラーが発生しました。",
    };
  }
}
