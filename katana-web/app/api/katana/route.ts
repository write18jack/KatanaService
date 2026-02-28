import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

/**
 * モバイルアプリのトップ画面などで表示する「販売中」の刀剣データを返すエンドポイント
 */
export async function GET() {
  try {
    // ステータスが「販売中」のものだけを取得
    const katanas = await prisma.katana.findMany({
      where: { status: "販売中" },
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
