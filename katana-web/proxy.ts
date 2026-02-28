import NextAuth from "next-auth";
import authConfig from "./auth.config";
import { NextResponse } from "next/server";

// middleware.ts: /dashboard などの保護されたページを守る「門番」の役割。
// proxy.ts は古い形式や特定のライブラリの推奨?

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth;
  const role = req.auth?.user?.role;

  // 1. そもそもログインしていない場合、ログイン画面へ強制リダイレクト
  if (!isLoggedIn && nextUrl.pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/login", nextUrl));
  }

  // 2. /dashboard 直下にアクセスした場合の振り分け
  if (nextUrl.pathname === "/dashboard") {
    const path =
      role === "admin" ? "/dashboard/admin/requests" : "/dashboard/user";
    return NextResponse.redirect(new URL(path, nextUrl));
  }

  // 3. 管理者専用ページのガード ((/dashboard/admin/...) へのアクセス制限)
  if (nextUrl.pathname.startsWith("/dashboard/admin") && role !== "admin") {
    return NextResponse.redirect(new URL("/403", nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  // ダッシュボード以下のすべてのページにこの Middleware を適用
  matcher: ["/dashboard/:path*", "/login", "/register"],
};
