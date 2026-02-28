import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { createKatanaRequest } from "@/actions/user-katana";

/**
 * モバイルアプリから新規登録、変更、削除の申請を送信するためのエンドポイント
 * createKatanaRequest サーバーアクションを再利用
 */
export async function POST(req: NextRequest) {
  // 1. 認証チェック (Session Strategyの場合)
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { crudType, katanaId, values } = body; //

    // 既存のサーバーアクションを呼び出し
    // 戻り値の型に合わせて処理を分岐
    let result;
    if (crudType === "CREATE") {
      result = await createKatanaRequest("CREATE", values);
    } else if (crudType === "UPDATE") {
      result = await createKatanaRequest("UPDATE", katanaId, values);
    } else if (crudType === "DELETE") {
      result = await createKatanaRequest("DELETE", katanaId);
    } else {
      return NextResponse.json(
        { error: "不正な crudType です" },
        { status: 400 },
      );
    }

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: result.success });
  } catch (error) {
    return NextResponse.json(
      { error: "リクエストの解析に失敗しました" },
      { status: 500 },
    );
  }
}
