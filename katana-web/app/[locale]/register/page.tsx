import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * 自己登録は受け付けていない（docs/PLAN-authorization-fixes.md の案 C-1）。
 * URL を直接開いた人に案内だけを表示する。登録の処理（registerUser）もサーバー側で止めている。
 */
export default function RegisterPage() {
  return (
    <div className="relative flex min-h-screen flex-col items-center bg-gray-50">
      {/* 戻るリンクを画面左上に絶対配置 */}
      <div className="absolute top-8 left-8">
        <Button variant="ghost" asChild className="p-0 hover:bg-transparent">
          <Link
            href="/"
            className="text-muted-foreground hover:text-primary flex items-center gap-1"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>トップページへ戻る</span>
          </Link>
        </Button>
      </div>

      <div className="mt-32 w-full max-w-md px-4">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-center text-2xl font-bold">
              新規登録の受付停止中
            </CardTitle>
            <CardDescription className="text-center">
              現在、新規登録は受け付けていません。
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col gap-4">
            <p className="text-muted-foreground text-center text-sm">
              既にアカウントをお持ちですか？{" "}
              <Link href="/login" className="text-primary hover:underline">
                ログイン
              </Link>
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
