import { z } from "zod";

// validatino用ファイル
export const loginSchema = z.object({
  username: z.string().min(1, "ユーザー名を入力してください"),
  password: z.string().min(1, "パスワードを入力してください"),
});
export type LoginForm = z.infer<typeof loginSchema>;
