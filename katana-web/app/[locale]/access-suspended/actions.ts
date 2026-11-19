"use server";

import { signOut } from "@/auth";
import { routing } from "@/i18n/routing";

/**
 * アクセス停止画面の手動ログアウト。ボタン操作時にだけ呼ばれる。
 * locale はリダイレクト先の組み立てにだけ使い、対応ロケール以外は既定ロケールに置き換える。
 */
export async function logoutFromSuspended(locale: string) {
  const target = (routing.locales as readonly string[]).includes(locale) ? locale : routing.defaultLocale;
  await signOut({ redirectTo: `/${target}/login` });
}
