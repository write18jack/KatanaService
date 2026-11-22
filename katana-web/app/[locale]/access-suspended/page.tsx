import { LogOut, ShieldAlert } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { logoutFromSuspended } from "./actions";

/**
 * 削除済みユーザー・無効店舗のユーザー向けのアクセス停止画面。
 * JWTが残っていても表示できるよう、ダッシュボードの外に置き、認可やDB参照は行わない。
 * 表示しただけではログアウトしない（店舗の再有効化後に既存セッションで再開できるようにするため）。
 */
export default async function AccessSuspendedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AccessSuspended" });

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-4">
      <div className="max-w-xl space-y-6 text-center">
        <div className="flex justify-center">
          <ShieldAlert className="text-destructive h-16 w-16" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
        <form action={logoutFromSuspended.bind(null, locale)} className="flex justify-center">
          <Button variant="outline" type="submit" className="gap-2">
            <LogOut className="size-4" />
            {t("logout")}
          </Button>
        </form>
      </div>
    </div>
  );
}
