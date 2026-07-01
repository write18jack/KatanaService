import { auth } from "@/auth";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getTranslations } from "next-intl/server";

// ユーザーが最初にアクセスする「看板」の役割。
export default async function HomePage() {
  const t = await getTranslations("Home");
  const session = await auth();

  return (
    <main className="min-h-[calc(100vh-56px)] w-full bg-blue-200 pt-14">
      <div className="flex h-full w-full flex-col p-8">
        <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">
          {t("title")}
        </h1>
        <p className="mt-8 text-lg text-gray-600">{t("description")}</p>

        <div className="mt-8 items-center gap-4">
          {session ? (
            <Button asChild>
              <Link href="/dashboard">ダッシュボードへ（ログイン済み）</Link>
            </Button>
          ) : (
            <>
              {/* ログイン画面へのリンク */}
              <Button asChild variant="outline">
                <Link href="/login">ログイン</Link>
              </Button>

              {/* 新規登録画面へのリンク（app/(auth)/register/page.tsx に対応） */}
              <Button asChild>
                <Link href="/register">新規アカウント登録</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
