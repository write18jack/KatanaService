"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadMasterCaches } from "@/lib/product-import/masterCache";
import { validateRow, type ValidatedRowData } from "@/lib/product-import/validateRow";

type ConfirmImportResult = { success?: string; error?: string };

// Product upsertで比較・記録する対象フィールド（インポートフォーマットが制御する範囲のみ）
function toSnapshot(data: {
  title: string;
  categoryId: string;
  makerId: string | null;
  appraiserId: string | null;
  gradeId: string | null;
  rankId: string | null;
  periodId: string | null;
  provinceId: string | null;
  swordEraId: string;
  price: number | null;
  bladeLength: Prisma.Decimal | number | null;
  curvature: Prisma.Decimal | number | null;
}) {
  return {
    title: data.title,
    categoryId: data.categoryId,
    makerId: data.makerId,
    appraiserId: data.appraiserId,
    gradeId: data.gradeId,
    rankId: data.rankId,
    periodId: data.periodId,
    provinceId: data.provinceId,
    swordEraId: data.swordEraId,
    price: data.price,
    bladeLength: data.bladeLength === null ? null : Number(data.bladeLength),
    curvature: data.curvature === null ? null : Number(data.curvature),
  };
}

/**
 * 検証済みImportJobを確定し、SUCCESS行のみをProductへ反映する。
 * Product / PriceHistory / ProductHistory / ImportJob(+ImportRow) の整合性を
 * 1トランザクションで保証する。
 */
export async function confirmImport(importJobId: string): Promise<ConfirmImportResult> {
  const session = await auth();
  if (!session?.user?.id || !session.user.shopId) {
    return { error: "認証が必要です。" };
  }

  const importJob = await prisma.importJob.findUnique({
    where: { id: importJobId },
    include: { rows: true },
  });

  if (!importJob || importJob.shopId !== session.user.shopId) {
    return { error: "取込ジョブが見つかりません。" };
  }

  if (importJob.status !== "PENDING") {
    return { error: "このジョブはすでに処理済みです。" };
  }

  const shopId = importJob.shopId;
  const executedById = session.user.id;
  const masters = await loadMasterCaches();

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.importJob.update({
          where: { id: importJobId },
          data: { status: "PROCESSING" },
        });

        for (const row of importJob.rows) {
          if (row.status !== "SUCCESS") continue;

          const rawData = row.rawData as unknown as Record<string, string> | null;
          if (!rawData) continue;

          // マスタが検証時から変更された可能性があるため確定時に再検証する
          const result = validateRow(rawData, masters);
          if (result.status !== "SUCCESS") {
            await tx.importRow.update({
              where: { id: row.id },
              data: {
                status: "ERROR",
                message:
                  result.status === "ERROR"
                    ? result.message
                    : "確定時点で内容を検証できませんでした。",
              },
            });
            continue;
          }

          const data: ValidatedRowData = result.data;
          const newValue = toSnapshot(data);

          const existing = await tx.product.findUnique({
            where: { shopId_productCode: { shopId, productCode: data.productCode } },
          });

          let productId: string;

          if (existing) {
            const oldValue = toSnapshot(existing);

            await tx.product.update({
              where: { id: existing.id },
              data: { ...newValue, updatedById: executedById },
            });

            productId = existing.id;

            if (data.price !== null && data.price !== existing.price) {
              await tx.priceHistory.create({
                data: {
                  productId,
                  oldPrice: existing.price,
                  newPrice: data.price,
                },
              });
            }

            await tx.productHistory.create({
              data: {
                productId,
                action: "IMPORT",
                changedById: executedById,
                oldValue,
                newValue,
              },
            });
          } else {
            const created = await tx.product.create({
              data: {
                shopId,
                productCode: data.productCode,
                ...newValue,
                createdById: executedById,
                updatedById: executedById,
                status: "ACTIVE",
                listedAt: new Date(),
              },
            });

            productId = created.id;

            if (data.price !== null) {
              await tx.priceHistory.create({
                data: {
                  productId,
                  oldPrice: null,
                  newPrice: data.price,
                },
              });
            }

            await tx.productHistory.create({
              data: {
                productId,
                action: "IMPORT",
                changedById: executedById,
                oldValue: Prisma.JsonNull,
                newValue,
              },
            });
          }
        }

        await tx.importJob.update({
          where: { id: importJobId },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
      },
      { timeout: 30000 },
    );
  } catch (error) {
    console.error("Import confirm error:", error);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: "FAILED", completedAt: new Date() },
    });
    return { error: "取込の確定処理に失敗しました。" };
  }

  revalidatePath("/dashboard/products");
  revalidatePath(`/dashboard/import/${importJobId}`);

  return { success: "取込を確定しました。" };
}
