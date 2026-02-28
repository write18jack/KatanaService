"use server";

import { signIn, auth } from "@/auth";
import { LoginForm, loginSchema } from "@/types/login-form";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

// api\auth\[...nextauth]\route.tsからsignInロジックを
// 分離して実装してる
const credentialsLogin = async (values: LoginForm) => {
  const safeValues = await loginSchema.safeParseAsync(values);

  if (!safeValues.success) {
    return "入力エラー";
  }

  try {
    // ログインを実行
    await signIn("credentials", {
      ...safeValues.data,
      // 固定のパスではなく、ミドルウェアが判断するベースパスを指定
      redirectTo: "/dashboard",
    });
    return null;
  } catch (err) {
    if (err instanceof AuthError) {
      return "ログイン失敗";
    }
    throw err;
  }
};

export { credentialsLogin };
