import { z } from "zod";

export const registerSchema = z.object({
  shopName: z
    .string()
    .min(1, "店舗名は必須です")
    .max(100, "店舗名は100文字以内で入力してください"),

  name: z
    .string()
    .min(1, "担当者名は必須です")
    .max(100, "担当者名は100文字以内で入力してください"),

  email: z.email("メールアドレスの形式が正しくありません"),

  password: z.string().min(8, "パスワードは8文字以上で入力してください"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
