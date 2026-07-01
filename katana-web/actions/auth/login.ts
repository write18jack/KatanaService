"use server";

import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { LoginForm, loginSchema } from "@/types/login-form";

export async function credentialsLogin(values: LoginForm, locale: string) {
  const safeValues = await loginSchema.safeParseAsync(values);

  if (!safeValues.success) {
    return "入力エラー";
  }

  try {
    await signIn("credentials", {
      ...safeValues.data,
      redirectTo: `/${locale}/dashboard`,
    });

    return null;
  } catch (err) {
    if (err instanceof AuthError) {
      return "ログイン失敗";
    }

    throw err;
  }
}
