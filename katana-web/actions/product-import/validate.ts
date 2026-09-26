"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseImportFile } from "@/lib/product-import/parseFile";
import { loadMasterCaches, normalizeMasterValue } from "@/lib/product-import/masterCache";
import {
  validateRow,
  STRUCTURALLY_REQUIRED_COLUMNS,
} from "@/lib/product-import/validateRow";

// MVP v1では1トランザクションで確定処理を行うため、行数に上限を設ける
const MAX_IMPORT_ROWS = 5000;

type ValidateImportResult = { importJobId?: string; error?: string };

/**
 * アップロードされたExcel/CSVファイルを検証し、ImportJob/ImportRowとして保存する。
 * この時点ではProduct/PriceHistory/ProductHistoryには一切書き込まない。
 */
export async function validateImport(formData: FormData): Promise<ValidateImportResult> {
  const session = await auth();
  if (!session?.user?.id || !session.user.shopId) {
    return { error: "認証が必要です。" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "ファイルを選択してください。" };
  }

  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".csv") && !lowerName.endsWith(".xlsx") && !lowerName.endsWith(".xls")) {
    return { error: "対応していないファイル形式です（.xlsx / .csv のみ）。" };
  }

  let parsed: Awaited<ReturnType<typeof parseImportFile>>;
  try {
    parsed = await parseImportFile(file);
  } catch (error) {
    console.error("Import file parse error:", error);
    return { error: "ファイルの読み込みに失敗しました。ファイル形式を確認してください。" };
  }

  const missingHeaders = STRUCTURALLY_REQUIRED_COLUMNS.filter(
    (col) => !parsed.headers.includes(col),
  );
  if (missingHeaders.length > 0) {
    return {
      error: `必須列が見つかりません: ${missingHeaders.join(", ")}`,
    };
  }

  if (parsed.rows.length === 0) {
    return { error: "データ行がありません。" };
  }

  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return { error: `1ファイルあたり最大${MAX_IMPORT_ROWS}行までです。` };
  }

  const masters = await loadMasterCaches();
  const seenProductCodes = new Set<string>();

  const rowResults = parsed.rows.map((row, index) => {
    // ヘッダー行を1行目とみなし、データは2行目から
    const rowNumber = index + 2;
    const fallbackProductCode = (row["product_code"] ?? "").toString().trim() || null;

    const result = validateRow(row, masters);

    if (result.status === "SKIPPED") {
      return {
        rowNumber,
        productCode: fallbackProductCode,
        status: "SKIPPED" as const,
        message: null,
        rawData: row,
      };
    }

    if (result.status === "ERROR") {
      return {
        rowNumber,
        productCode: fallbackProductCode,
        status: "ERROR" as const,
        message: result.message,
        rawData: row,
      };
    }

    // SUCCESS：ファイル内での商品コード重複を確認
    const normalizedCode = normalizeMasterValue(result.data.productCode);
    if (seenProductCodes.has(normalizedCode)) {
      return {
        rowNumber,
        productCode: result.data.productCode,
        status: "ERROR" as const,
        message: "ファイル内に重複する商品コードがあります。",
        rawData: row,
      };
    }
    seenProductCodes.add(normalizedCode);

    return {
      rowNumber,
      productCode: result.data.productCode,
      status: "SUCCESS" as const,
      message: null,
      rawData: row,
    };
  });

  const totalRows = rowResults.length;
  const successRows = rowResults.filter((r) => r.status === "SUCCESS").length;
  const errorRows = rowResults.filter((r) => r.status === "ERROR").length;

  const importJob = await prisma.importJob.create({
    data: {
      shopId: session.user.shopId,
      fileName: file.name,
      status: "PENDING",
      totalRows,
      successRows,
      errorRows,
      executedById: session.user.id,
      startedAt: new Date(),
      rows: {
        create: rowResults.map((r) => ({
          rowNumber: r.rowNumber,
          productCode: r.productCode,
          status: r.status,
          message: r.message,
          rawData: r.rawData,
        })),
      },
    },
  });

  return { importJobId: importJob.id };
}
