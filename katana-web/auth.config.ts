import Credentials from "next-auth/providers/credentials";
import type { NextAuthConfig } from "next-auth";
import { loginSchema } from "@/types/login-form";
import { getUserFromDb } from "@/data/user";

// 認証ロジックだけをまとめる
export default {
  session: { strategy: "jwt" },

  providers: [
    // ここではプロバイダーを空にするか、検証なしの定義のみにする
    // Credentials({
    //   credentials: { username: {}, password: {} },
    //   authorize: async (credentials) => {
    //     const { username, password } =
    //       await loginSchema.parseAsync(credentials);
    //     const user = await getUserFromDb(username, password);
    //     if (!user) throw new Error("ユーザー名かパスワードが違います。");
    //     return user;
    //   },
    // }),
  ],
  callbacks: {
    // // role に応じたリダイレクト処理
    // authorized({ auth, request: { nextUrl } }) {
    //   const isLoggedIn = !!auth?.user;
    //   const isAdmin = auth?.user?.role === "admin";

    //   // 例: 管理者専用ページへのアクセス制限
    //   if (nextUrl.pathname.startsWith("/dashboard/admin")) {
    //     return isLoggedIn && isAdmin;
    //   }
    //   return isLoggedIn;
    // },
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        // Prisma で KatanaRequest を作成する際、applicantId に
        // session.user.id を割り当てる必要があるためuser.id を token に持たせる
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = token.role as string;
        session.user.id = token.id as string; // token から session.user に id を渡す
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
