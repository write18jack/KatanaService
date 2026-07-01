import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { auth } from "@/auth";
import { routing } from "@/i18n/routing";

const intlMiddleware = createMiddleware(routing);

export default auth((req) => {
  const response = intlMiddleware(req);

  const pathname = req.nextUrl.pathname;

  const locale =
    routing.locales.find((l) => pathname.startsWith(`/${l}`)) ??
    routing.defaultLocale;

  const pathnameWithoutLocale = pathname.replace(
    new RegExp(`^/(${routing.locales.join("|")})`),
    "",
  ) || "/";

  console.log({
    pathname: pathname,
    locale: locale,
    pathnameWithoutLocale: pathnameWithoutLocale,
  });

  const isLoggedIn = !!req.auth;
  const role = req.auth?.user?.role;

  // 認証不要ページ
  const publicRoutes = ["/", "/login", "/register", "/403"];

  const isPublicRoute = publicRoutes.some(
    (route) =>
      pathnameWithoutLocale === route ||
      pathnameWithoutLocale.startsWith(`${route}/`),
  );

  // 未ログインで保護ページへアクセス
  if (!isLoggedIn && !isPublicRoute) {
    return NextResponse.redirect(new URL(`/${locale}/login`, req.url));
  }

  // ログイン済みで login/register にアクセス
  if (isLoggedIn && ["/login", "/register"].includes(pathnameWithoutLocale)) {
    return NextResponse.redirect(new URL(`/${locale}/dashboard`, req.url));
  }

  // 管理者専用
  if (
    pathnameWithoutLocale.startsWith("/dashboard/admin") &&
    role !== "admin"
  ) {
    return NextResponse.redirect(new URL(`/${locale}/403`, req.url));
  }
  return response;
});

export const config = {
  matcher: [
    "/",
    "/(ja|en)/:path*",

    // next-intl 推奨設定
    "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
  ],
};
