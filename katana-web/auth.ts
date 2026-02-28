//export const runtime = "nodejs"; // Prisma を使うため必須

import NextAuth from "next-auth";
import authConfig from "./auth.config";
import Credentials from "next-auth/providers/credentials";
import { loginSchema } from "@/types/login-form";
import { getUserFromDb } from "@/data/user"; // ここでbcryptを使う関数を呼ぶ

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      async authorize(credentials) {
        const validated = loginSchema.safeParse(credentials);
        if (validated.success) {
          const { username, password } = validated.data;
          const user = await getUserFromDb(username, password);
          if (user) return user;
        }
        return null;
      },
    }),
  ],
});
