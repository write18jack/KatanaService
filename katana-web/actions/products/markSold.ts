"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

type MarkSoldResult = { success?: string; error?: string };

/**
 * ACTIVE商品をSOLDへ手動遷移する。
 * Product.status/soldAt更新とProductHistory(STATUS_CHANGE)記録を
 * 同一transactionで行い、自店舗の商品のみ操作可能とする。
 */
export async function markProductAsSold(productId: string): Promise<MarkSoldResult> {
  const session = await auth();
  if (!session?.user?.id || !session.user.shopId) {
    return { error: "認証が必要です。" };
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product || product.shopId !== session.user.shopId) {
    return { error: "商品が見つかりません。" };
  }

  if (product.status !== "ACTIVE") {
    return { error: "この商品はすでに販売済み、または対象外の状態です。" };
  }

  const changedById = session.user.id;
  const soldAt = new Date();

  await prisma.$transaction([
    prisma.product.update({
      where: { id: productId },
      data: {
        status: "SOLD",
        soldAt,
        updatedById: changedById,
      },
    }),
    prisma.productHistory.create({
      data: {
        productId,
        action: "STATUS_CHANGE",
        changedById,
        oldValue: { status: "ACTIVE" },
        newValue: { status: "SOLD" },
      },
    }),
  ]);

  revalidatePath("/dashboard/products");

  return { success: "商品を販売済みにしました。" };
}
