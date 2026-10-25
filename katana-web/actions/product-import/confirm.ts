"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { prisma } from "@/lib/prisma";
import { loadMasterCaches } from "@/lib/product-import/masterCache";
import { shouldRecordPriceChange } from "@/lib/product-import/priceHistory";
import { validateRow, type ValidatedRowData } from "@/lib/product-import/validateRow";

type ConfirmImportResult = { success?: string; error?: string };

/** 条件付き更新でジョブの実行権（PENDING → PROCESSING）を取得できなかったことを示す */
class ImportJobNotClaimableError extends Error {}

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
  // 認可はDBの最新状態で行う（JWTの shopId・role はログイン時点の値のため使わない）
  const authResult = await getAuthContext();
  if (!authResult.ok) {
    return { error: "認証が必要です。" };
  }
  const { userId, shopId } = authResult.context;

  // 他店舗のジョブはDB取得の時点で除外する（存在しないジョブと同じ扱いになる）
  const importJob = await prisma.importJob.findUnique({
    where: { id: importJobId, shopId },
    include: { rows: true },
  });

  if (!importJob || importJob.shopId !== shopId) {
    return { error: "取込ジョブが見つかりません。" };
  }

  if (importJob.status !== "PENDING") {
    return { error: "このジョブはすでに処理済みです。" };
  }

  const executedById = userId;
  const masters = await loadMasterCaches();
  // 実行権を取得したか。rollback後はDB上の実行権を失っているため、FAILED記録の可否判断にだけ使う
  let claimed = false;

  try {
    await prisma.$transaction(
      async (tx) => {
        // 同時確定対策: PENDINGのジョブだけを条件付きでPROCESSINGにし、1件取れたリクエストだけが反映する。
        // 先行リクエストが確定済みなら条件に一致せず0件になる。
        const claim = await tx.importJob.updateMany({
          where: { id: importJobId, shopId, status: "PENDING" },
          data: { status: "PROCESSING" },
        });
        if (claim.count !== 1) {
          throw new ImportJobNotClaimableError();
        }
        claimed = true;

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

            if (shouldRecordPriceChange(existing.price, data.price)) {
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

            if (shouldRecordPriceChange(null, data.price)) {
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

        const completed = await tx.importJob.updateMany({
          where: { id: importJobId, shopId, status: "PROCESSING" },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
        if (completed.count !== 1) {
          throw new Error("ImportJob was not in PROCESSING state at completion");
        }
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (error instanceof ImportJobNotClaimableError) {
      return { error: "このジョブはすでに処理済みです。" };
    }
    console.error("Import confirm error:", error);
    if (claimed) {
      // rollbackでPENDINGへ戻っている場合だけFAILEDにする。
      // 他リクエストが確定済み（COMPLETED）・処理中（PROCESSING）のジョブは上書きしない。
      await prisma.importJob.updateMany({
        where: { id: importJobId, shopId, status: "PENDING" },
        data: { status: "FAILED", completedAt: new Date() },
      });
    }
    return { error: "取込の確定処理に失敗しました。" };
  }

  revalidatePath("/dashboard/products");
  revalidatePath(`/dashboard/import/${importJobId}`);

  return { success: "取込を確定しました。" };
}
