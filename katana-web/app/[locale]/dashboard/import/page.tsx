import { requireDashboardContext } from "../_lib/requireDashboardContext";
import ImportUploadForm from "./_components/ImportUploadForm";

export default async function ImportPage() {
  // 無効店舗・削除済みユーザーには取り込み画面も表示しない
  await requireDashboardContext();

  return (
    <main className="space-y-6 p-8">
      <div>
        <h1 className="text-3xl font-bold">Excel/CSV取込</h1>
        <p className="text-muted-foreground mt-1">
          在庫データをアップロードし、内容を確認してから取り込みます。
        </p>
      </div>

      <ImportUploadForm />
    </main>
  );
}
