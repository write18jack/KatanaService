import { Katana, KatanaRequest } from "@prisma/client";

// 変更内容を視覚的に表示するコンポーネント

interface RequestPreviewProps {
  request: KatanaRequest;
  currentKatana?: Katana | null; // UPDATE/DELETEの場合に既存データを渡す
}

export function RequestPreview({
  request,
  currentKatana,
}: RequestPreviewProps) {
  // 修正ポイント: request.data をパースするのではなく、request 本体のカラムを参照します
  // これにより、Jsonがnullであっても実行時エラーを防げます

  const isCreate = request.crudType === "CREATE";
  const isUpdate = request.crudType === "UPDATE";
  const isDelete = request.crudType === "DELETE";

  if (isCreate) {
    return (
      <div className="space-y-2 rounded-lg border bg-green-50 p-4">
        <p className="font-bold text-green-700">【新規登録の内容】</p>
        <ul className="space-y-1 text-sm">
          <li>銘: {request.name || "（未入力）"}</li>
          <li>種別: {request.katanaType || "（未入力）"}</li>
          <li>時代: {request.era || "（未入力）"}</li>
          <li>価格: {request.price?.toLocaleString() || "0"}円</li>
          <li>店舗名: {request.shopName}</li>
        </ul>
      </div>
    );
  }

  if (isUpdate && currentKatana) {
    return (
      <div className="space-y-2 rounded-lg border bg-blue-50 p-4">
        <p className="font-bold text-blue-700">【変更内容の比較】</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th>項目</th>
              <th>現在</th>
              <th>変更後</th>
            </tr>
          </thead>
          <tbody>
            <DiffRow
              label="銘"
              oldVal={currentKatana.name}
              newVal={request.name}
            />
            <DiffRow
              label="種別"
              oldVal={currentKatana.katanaType}
              newVal={request.katanaType}
            />
            <DiffRow
              label="時代"
              oldVal={currentKatana.era ?? ""}
              newVal={request.era || ""}
            />
            <DiffRow
              label="価格"
              oldVal={`${currentKatana.price.toLocaleString()}円`}
              newVal={`${(request.price || 0).toLocaleString()}円`}
            />
          </tbody>
        </table>
      </div>
    );
  }

  if (isDelete && currentKatana) {
    return (
      <div className="space-y-2 rounded-lg border bg-red-50 p-4">
        <p className="font-bold text-red-700">【削除対象の刀剣】</p>
        <p className="text-sm">
          {currentKatana.name} ({currentKatana.katanaType}) を削除します。
        </p>
      </div>
    );
  }

  return null;
}

function DiffRow({
  label,
  oldVal,
  newVal,
}: {
  label: string;
  oldVal: string;
  newVal: string;
}) {
  const isChanged = oldVal !== newVal;
  return (
    <tr className="border-t">
      <td className="py-1 font-medium">{label}</td>
      <td className="py-1 text-gray-500">{oldVal}</td>
      <td className={`py-1 ${isChanged ? "font-bold text-blue-600" : ""}`}>
        {isChanged ? `→ ${newVal}` : "（変更なし）"}
      </td>
    </tr>
  );
}
