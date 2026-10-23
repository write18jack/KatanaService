"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

type MarkSoldResult = { success?: string; error?: string };

/** 条件付き更新が1件にならなかったことを示す（transactionをrollbackさせるために投げる） */
class ProductNotActiveError extends Error {}

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

  // 他店舗の商品はDB取得の時点で除外する（存在しない商品と同じ扱いになる）
  const product = await prisma.product.findUnique({
    where: { id: productId, shopId: session.user.shopId },
  });

  if (!product || product.shopId !== session.user.shopId) {
    return { error: "商品が見つかりません。" };
  }

  if (product.status !== "ACTIVE") {
    return { error: "この商品はすでに販売済み、または対象外の状態です。" };
  }

  const changedById = session.user.id;
  const soldAt = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      // 同時リクエスト対策: ACTIVEの行だけを条件付きで更新する。
      // 先行リクエストがSOLDにした後は条件に一致せず0件となり、soldAtも上書きされない。
      const { count } = await tx.product.updateMany({
        where: { id: productId, shopId: session.user.shopId, status: "ACTIVE" },
        data: {
          status: "SOLD",
          soldAt,
          updatedById: changedById,
        },
      });

      if (count !== 1) {
        throw new ProductNotActiveError();
      }

      await tx.productHistory.create({
        data: {
          productId,
          action: "STATUS_CHANGE",
          changedById,
          oldValue: { status: "ACTIVE" },
          newValue: { status: "SOLD" },
        },
      });
    });
  } catch (error) {
    if (error instanceof ProductNotActiveError) {
      return { error: "この商品はすでに販売済み、または対象外の状態です。" };
    }
    throw error;
  }

  revalidatePath("/dashboard/products");

  return { success: "商品を販売済みにしました。" };
}
