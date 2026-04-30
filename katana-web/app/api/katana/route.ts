import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

/**
 * モバイルアプリのトップ画面などで表示する「販売中」の刀剣データを返すエンドポイント
 */
export async function GET() {
  try {
    // ステータスが「販売中」のものだけを取得
    const katanas = await prisma.katana.findMany({
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(katanas);
  } catch (error) {
    console.error("API GET Error:", error);
    return NextResponse.json(
      { error: "データの取得に失敗しました" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // データベースに保存
    const newKatana = await prisma.katana.create({
      data: {
        shopName: body.shopName,
        name: body.name,
        katanaType: body.katanaType,
        era: body.era,
        price: parseInt(body.price), // 数値への変換が必要な場合があります
        status: body.status,
        imageUrl: body.imageUrl,
        dealerId: body.dealerId,
      },
    });

    return NextResponse.json(newKatana, { status: 201 });
  } catch (error) {
    console.error("POST Error:", error);
    return NextResponse.json(
      { error: "Failed to create katana" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const body = await request.json();

    if (!id)
      return NextResponse.json({ error: "ID required" }, { status: 400 });

    const updated = await prisma.katana.update({
      where: { id: id },
      data: {
        shopName: body.shopName,
        name: body.name,
        katanaType: body.katanaType,
        era: body.era,
        price: parseInt(body.price),
        imageUrl: body.imageUrl,
        // dealerId は基本更新しない
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PUT Error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    // URLから ?id=xxx の部分を取得
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const dealerId = searchParams.get("dealerId"); // ユーザーIDを受け取る

    if (!id || !dealerId) {
      return NextResponse.json(
        { error: "IDとユーザー情報が必要です" },
        { status: 400 },
      );
    }

    // 所有者チェックを含めた削除
    // deleteMany を使うと、条件に合わない（他人のデータ）場合は「0件削除」になりエラーにならず安全です
    const result = await prisma.katana.deleteMany({
      where: {
        id: id,
        dealerId: dealerId, // ここが重要！
      },
    });

    if (result.count === 0) {
      return NextResponse.json(
        { error: "削除権限がないか、データが存在しません" },
        { status: 403 },
      );
    }

    return NextResponse.json({ message: "削除に成功しました" });
  } catch (error) {
    console.error("DELETE Error:", error);
    return NextResponse.json(
      { error: "削除処理に失敗しました" },
      { status: 500 },
    );
  }
}
