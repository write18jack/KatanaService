import { auth } from "@/auth";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// ユーザーが最初にアクセスする「看板」の役割。
export default async function HomePage() {
  const session = await auth();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-24">
      <div className="z-10 flex w-full max-w-5xl flex-col items-center justify-center gap-8 text-center font-mono text-sm">
        <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl">
          刀剣管理システム
        </h1>
        <p className="text-lg leading-8 text-gray-600">
          刀剣の登録申請、修正、在庫管理を効率的に行うためのプラットフォームです。
        </p>

        <div className="flex items-center gap-4">
          {session ? (
            <Button asChild size="lg">
              <Link href="/dashboard">ダッシュボードへ（ログイン済み）</Link>
            </Button>
          ) : (
            <>
              {/* ログイン画面へのリンク */}
              <Button asChild variant="outline" size="lg">
                <Link href="/login">ログイン</Link>
              </Button>

              {/* 新規登録画面へのリンク（app/(auth)/register/page.tsx に対応） */}
              <Button asChild size="lg">
                <Link href="/register">新規アカウント登録</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
