"use server";

import prisma from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function approveKatanaRequest(requestId: string) {
  try {
    const request = await prisma.katanaRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) return { error: "申請が見つかりません。" };

    if (request.crudType === "CREATE") {
      // KatanaRequest -> Katana へマッピング
      await prisma.katana.create({
        data: {
          shopName: request.shopName,
          name: request.name,
          katanaType: request.katanaType,
          era: request.era,
          price: request.price,
          status: "販売中",
          dealerId: request.applicantId,
        },
      });
    } else if (request.crudType === "UPDATE" && request.targetKatanaId) {
      await prisma.katana.update({
        where: { id: request.targetKatanaId },
        data: {
          shopName: request.shopName,
          name: request.name,
          katanaType: request.katanaType,
          era: request.era,
          price: request.price,
        },
      });
    } else if (request.crudType === "DELETE" && request.targetKatanaId) {
      await prisma.katana.delete({
        where: { id: request.targetKatanaId },
      });
    }

    // 申請ステータスを更新
    await prisma.katanaRequest.update({
      where: { id: requestId },
      data: { status: "APPROVED" },
    });

    revalidatePath("/dashboard/admin/requests");
    return { success: "申請を承認しました。" };
  } catch (error) {
    console.error("Approval Error:", error);
    return {
      error:
        "承認処理中にエラーが発生しました。フィールド名を確認してください。",
    };
  }
}

export async function rejectKatanaRequest(requestId: string) {
  try {
    await prisma.katanaRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED" },
    });
    revalidatePath("/dashboard/admin/requests");
    return { success: "申請を却下しました。" };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    return { error: "却下処理中にエラーが発生しました。" };
  }
}
