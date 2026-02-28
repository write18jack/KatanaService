"use server";

import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { katanaSchema, KatanaInput } from "./katana-schema";

/**
 * 刀剣の登録・変更・削除申請を作成するサーバーアクション
 * ユーザー自身の操作（申請の作成）のみを記述
 */

// 1. 型定義（オーバーロード）
export async function createKatanaRequest(
  crudType: "CREATE",
  values: KatanaInput,
): Promise<{ success?: string; error?: string }>;

export async function createKatanaRequest(
  crudType: "UPDATE",
  katanaId: string,
  values: KatanaInput,
): Promise<{ success?: string; error?: string }>;

export async function createKatanaRequest(
  crudType: "DELETE",
  katanaId: string,
): Promise<{ success?: string; error?: string }>;

// 2. 実装（実体は 1 つ）
export async function createKatanaRequest(
  crudType: "CREATE" | "UPDATE" | "DELETE",
  arg2?: string | KatanaInput,
  arg3?: KatanaInput,
) {
  // セッション（ユーザー情報）の取得
  const session = await auth();
  // 認証チェック
  if (!session?.user?.id) return { error: "認証が必要です。" };
  // デバッグ用ログ
  console.log("Current Session:", session);

  let katanaId: string | undefined;
  let values: KatanaInput | undefined;

  // 引数の整理
  if (crudType === "CREATE") {
    values = arg2 as KatanaInput;
  } else if (crudType === "UPDATE") {
    katanaId = arg2 as string;
    values = arg3 as KatanaInput;
  } else if (crudType === "DELETE") {
    katanaId = arg2 as string;
  }

  // requestData の型を明示する
  // KatanaRequest の一部のフィールドを持つオブジェクトとして定義
  let requestData: KatanaInput;

  try {
    if (crudType === "DELETE") {
      // 削除申請の場合：現在の刀剣情報をDBから取得してコピーする
      const target = await prisma.katana.findUnique({
        where: { id: katanaId },
      });
      if (!target) return { error: "対象の刀剣が見つかりません。" };

      requestData = {
        shopName: target.shopName,
        name: target.name,
        katanaType: target.katanaType as KatanaInput["katanaType"],
        era: target.era || "",
        price: target.price,
      };
    } else if (values) {
      // 新規・変更申請の場合：Zodでバリデーションを実行
      const validated = katanaSchema.safeParse(values);
      if (!validated.success) {
        console.error("Validation Error Details:", validated.error);
        return { error: "入力内容が不正です。" };
      }
      requestData = validated.data;
    } else {
      return { error: "不正なリクエストです。" };
    }

    // KatanaRequest モデルへの保存
    // values から取得した各項目を、モデル直下のカラムにマッピング
    await prisma.katanaRequest.create({
      data: {
        crudType: crudType,
        status: "PENDING", // 承認待ち
        applicantId: session.user.id,
        targetKatanaId: katanaId ?? null,
        ...requestData, // 確定したデータを展開
      },
    });

    revalidatePath("/dashboard/user");
    revalidatePath("/dashboard/admin/requests"); // 管理者画面も更新

    return { success: "申請を送信しました。管理者の承認をお待ちください。" };
  } catch (error) {
    console.error("Prisma Create Error:", error);
    return {
      error: "申請の送信に失敗しました。",
    };
  }
}
