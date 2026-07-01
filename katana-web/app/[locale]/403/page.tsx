import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react"; // アイコンを使用する場合

export default function Forbidden() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-4">
      <div className="space-y-6 text-center">
        <div className="flex justify-center">
          <ShieldAlert className="text-destructive h-20 w-20" />
        </div>
        <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl">
          403 - アクセス権限がありません
        </h1>
        <p className="mx-auto max-w-150 text-gray-500 md:text-xl">
          申し訳ありません。このページを表示するための権限が不足しています。
          管理者アカウントでログインし直すか、ダッシュボードへ戻ってください。
        </p>
        <div className="flex justify-center gap-4">
          <Button asChild variant="outline">
            <Link href="/">トップページへ</Link>
          </Button>
          <Button asChild>
            <Link href="/dashboard">ダッシュボードへ</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
