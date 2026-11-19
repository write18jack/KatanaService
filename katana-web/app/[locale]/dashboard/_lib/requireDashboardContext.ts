import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { getAuthContext, type AuthContext } from "@/lib/auth/context";

/**
 * ダッシュボード配下のページで、業務データを取得する前に呼ぶ認可チェック。
 * DBの最新状態で認可し、成功時はDB由来のコンテキスト（shopIdなど）を返す。
 * - 未ログイン → ログイン画面
 * - 削除済みユーザー・無効店舗 → アクセス停止画面（JWTが残っていても表示できるルート。
 *   ログイン画面へ送るとproxyが /dashboard へ戻し、ループするため）
 * - DB障害などの例外は捕捉せずに伝播させる（古いJWTで表示しない・停止と誤案内しない）
 */
export async function requireDashboardContext(): Promise<AuthContext> {
  const result = await getAuthContext();
  if (result.ok) return result.context;

  const locale = await getLocale();
  if (result.reason === "UNAUTHENTICATED") {
    return redirect({ href: "/login", locale });
  }
  return redirect({ href: "/access-suspended", locale });
}
