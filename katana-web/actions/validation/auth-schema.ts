import * as z from "zod";

export const registerSchema = z.object({
  name: z.string().min(2, "名前は2文字以上で入力してください"),
  email: z.string().email("有効なメールアドレスを入力してください"),
  password: z.string().min(6, "パスワードは6文字以上必要です"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
