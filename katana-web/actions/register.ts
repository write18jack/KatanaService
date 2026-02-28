"use server";

import prisma from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { RegisterInput, registerSchema } from "./auth-schema";

export async function registerUser(values: RegisterInput) {
  // Zodによるバリデーション
  const validatedFields = registerSchema.safeParse(values);

  if (!validatedFields.success) {
    return { error: "入力内容が正しくありません。" };
  }

  const { name, email, password } = validatedFields.data;

  try {
    // スキーマの整合性チェック (nameは @unique なので重複不可 )
    const existingUserByName = await prisma.user.findUnique({
      where: { name },
    });
    if (existingUserByName) {
      return { error: "このユーザー名は既に既に使用されています。" };
    }

    // emailも @unique なので重複チェック
    if (email) {
      const existingUserByEmail = await prisma.user.findUnique({
        where: { email },
      });
      if (existingUserByEmail) {
        return { error: "このメールアドレスは既に登録されています。" };
      }
    }

    // パスワードのハッシュ化 (保存時の安全性を確保 )
    const hashedPassword = await bcrypt.hash(password, 10);

    // ユーザーの作成
    await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword, // ハッシュ化したパスワードを保存
        role: "user", // デフォルトロールは一般ユーザー
      },
    });

    return { success: "ユーザー登録が完了しました。ログインしてください。" };
  } catch (error) {
    console.error("Registration error:", error);
    return { error: "登録中にエラーが発生しました。" };
  }
}
