import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import bcrypt from 'bcrypt';

export async function POST(request: Request) {
  try {
    const { name, password } = await request.json();
    console.log("Login attempt for:", name); // ログ追加

    // 1. ユーザーを「名前」で検索
    const user = await prisma.user.findUnique({
      where: { name: name },
    });

    if (!user) {
      console.log("User not found in DB"); // ログ追加
      return NextResponse.json({ error: "ユーザーが見つかりません" }, { status: 401 });
    }

    // 2. パスワードの照合 (ハッシュ化されたものと比較)
    const isMatch = await bcrypt.compare(password, user.password);
    console.log("Password match result:", isMatch); // ログ追加

    if (!isMatch) {
      return NextResponse.json({ error: "パスワードが正しくありません" }, { status: 401 });
    }

    // 3. 認証成功：Android側にユーザー情報を返す
    return NextResponse.json({
      id: user.id,
      name: user.name,
      role: user.role
    });

  } catch (error) {
    console.error("Login Error:", error);
    return NextResponse.json({ error: "サーバーエラーが発生しました" }, { status: 500 });
  }
}
