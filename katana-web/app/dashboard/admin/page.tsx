import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ClipboardList, Sword, Users } from "lucide-react"; // アイコンを使う場合

export default function AdminDashboardPage() {
  return (
    <div className="container mx-auto py-10">
      <h1 className="mb-8 text-3xl font-bold">管理者ダッシュボード</h1>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* 申請一覧への遷移カード */}
        <Card className="hover:border-primary transition-colors">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">登録申請の管理</CardTitle>
              <ClipboardList className="text-muted-foreground h-6 w-6" />
            </div>
            <CardDescription>
              ユーザーからの刀剣登録・変更申請を確認し、承認または却下を行います。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/dashboard/admin/requests">申請一覧を見る</Link>
            </Button>
          </CardContent>
        </Card>

        {/* 他の管理メニュー（例） */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">刀剣台帳</CardTitle>
              <Sword className="text-muted-foreground h-6 w-6" />
            </div>
            <CardDescription>
              登録済みのすべての刀剣データを閲覧・編集します。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="w-full" disabled>
              準備中
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
