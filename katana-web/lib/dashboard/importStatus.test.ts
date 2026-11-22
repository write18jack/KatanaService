import { ImportStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { describeImportResult, getImportStatusDisplay, type ImportResultInput } from "./importStatus";

function job(overrides: Partial<ImportResultInput>): ImportResultInput {
  return { status: "PENDING", totalRows: 125, successRows: 120, errorRows: 3, rowCounts: null, ...overrides };
}

describe("getImportStatusDisplay", () => {
  it("実際のImportStatus enumの全値に日本語ラベルがある", () => {
    const labels = Object.values(ImportStatus).map((status) => [status, getImportStatusDisplay(status)]);
    expect(Object.fromEntries(labels)).toEqual({
      PENDING: { label: "確認待ち", tone: "pending" },
      PROCESSING: { label: "処理中", tone: "processing" },
      COMPLETED: { label: "完了", tone: "completed" },
      FAILED: { label: "失敗", tone: "failed" },
    });
  });

  it("全statusが空でないテキストラベルを持つ（色だけに依存しない）", () => {
    for (const status of Object.values(ImportStatus)) {
      expect(getImportStatusDisplay(status).label.length).toBeGreaterThan(0);
    }
  });

  it("未知のstatusはクラッシュせず、DBの値をそのまま表示する", () => {
    expect(getImportStatusDisplay("CANCELLED")).toEqual({ label: "CANCELLED", tone: "unknown" });
    expect(getImportStatusDisplay("")).toEqual({ label: "", tone: "unknown" });
  });
});

describe("describeImportResult", () => {
  it("COMPLETED: 反映行数はImportRowの集計値を使い、検証時のsuccessRowsと混同しない", () => {
    // 検証時は120行OKだったが、確定時の再検証で2行がエラーになったケース
    const result = describeImportResult(
      job({ status: "COMPLETED", rowCounts: { success: 118, error: 5, skipped: 2 } }),
    );
    expect(result.primary).toBe("反映 118行");
    expect(result.secondary).toBe("エラー 5行・全 125行");
  });

  it("COMPLETED: 反映0行は「0行」と表示する", () => {
    const result = describeImportResult(
      job({ status: "COMPLETED", rowCounts: { success: 0, error: 125, skipped: 0 } }),
    );
    expect(result.primary).toBe("反映 0行");
  });

  it("COMPLETED: ImportRowの記録が無い場合は0行ではなく「記録なし」と表示する", () => {
    const result = describeImportResult(job({ status: "COMPLETED", rowCounts: null }));
    expect(result.primary).toBe("反映行数の記録なし");
    expect(result.primary).not.toContain("0行");
    expect(result.secondary).toBe("アップロード時: 検証OK 120行・エラー 3行・全 125行");
  });

  it("PENDING: 検証結果を「検証OK」として示し、反映済みとは表示しない", () => {
    const result = describeImportResult(job({ status: "PENDING" }));
    expect(result.primary).toBe("未反映（確定待ち）");
    expect(result.secondary).toBe("検証OK 120行・エラー 3行・全 125行");
  });

  it("FAILED: 検証OK行があっても反映なしと表示する", () => {
    const result = describeImportResult(job({ status: "FAILED" }));
    expect(result.primary).toBe("反映なし（商品は変更されていません）");
    expect(result.secondary).toContain("検証OK 120行");
  });

  it("PROCESSING・未知のstatusは未反映として検証結果のみ示す", () => {
    expect(describeImportResult(job({ status: "PROCESSING" })).primary).toBe("未反映");
    expect(describeImportResult(job({ status: "CANCELLED" })).primary).toBe("未反映");
  });

  it("件数は桁区切りで表示する", () => {
    const result = describeImportResult(
      job({ status: "COMPLETED", totalRows: 5000, rowCounts: { success: 4800, error: 200, skipped: 0 } }),
    );
    expect(result.primary).toBe("反映 4,800行");
    expect(result.secondary).toBe("エラー 200行・全 5,000行");
  });
});
