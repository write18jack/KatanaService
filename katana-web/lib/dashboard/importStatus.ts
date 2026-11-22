/**
 * ImportJobの状態・結果の表示ロジック（純粋関数のみ）。
 * Dashboardの取り込み履歴と、Import詳細画面の両方から使う。
 */

export type ImportStatusTone = "pending" | "processing" | "completed" | "failed" | "unknown";

const STATUS_LABELS: Record<string, { label: string; tone: ImportStatusTone }> = {
  // PENDINGは「検証済みで、ユーザーの確定操作を待っている」状態
  PENDING: { label: "確認待ち", tone: "pending" },
  PROCESSING: { label: "処理中", tone: "processing" },
  COMPLETED: { label: "完了", tone: "completed" },
  FAILED: { label: "失敗", tone: "failed" },
};

/** 未知のstatusは捨てずに、DBの値をそのままラベルとして表示する。 */
export function getImportStatusDisplay(status: string): { label: string; tone: ImportStatusTone } {
  return STATUS_LABELS[status] ?? { label: status, tone: "unknown" };
}

/** 確定処理後のImportRowをstatus別にDB側で数えた結果。 */
export type ImportRowCounts = { success: number; error: number; skipped: number };

export type ImportResultInput = {
  status: string;
  /** 以下3つはアップロード時の検証で記録され、確定後も更新されない */
  totalRows: number;
  successRows: number;
  errorRows: number;
  /** COMPLETEDのジョブのみ取得する。ImportRowの記録が無い場合はnull（0件とは区別する） */
  rowCounts: ImportRowCounts | null;
};

export type ImportResultDisplay = {
  primary: string;
  secondary: string | null;
};

const rows = (n: number) => `${n.toLocaleString("ja-JP")}行`;

/**
 * ImportJobの結果を、意味を取り違えないラベルで文章化する。
 * - 「検証OK」（アップロード時の検証を通過）と「反映」（商品へ実際に登録・更新）は別の数値として扱う。
 * - 新規登録/既存更新の内訳はDBに記録が無いため表示しない。
 */
export function describeImportResult(job: ImportResultInput): ImportResultDisplay {
  const validation = `検証OK ${rows(job.successRows)}・エラー ${rows(job.errorRows)}・全 ${rows(job.totalRows)}`;

  switch (job.status) {
    case "COMPLETED":
      if (job.rowCounts === null) {
        return { primary: "反映行数の記録なし", secondary: `アップロード時: ${validation}` };
      }
      return {
        primary: `反映 ${rows(job.rowCounts.success)}`,
        secondary: `エラー ${rows(job.rowCounts.error)}・全 ${rows(job.totalRows)}`,
      };
    case "FAILED":
      // 確定処理は1トランザクションのため、失敗時は商品へ一切反映されない
      return { primary: "反映なし（商品は変更されていません）", secondary: `アップロード時: ${validation}` };
    case "PENDING":
      return { primary: "未反映（確定待ち）", secondary: validation };
    default:
      return { primary: "未反映", secondary: validation };
  }
}
