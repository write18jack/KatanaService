import * as XLSX from "xlsx";

export type ParsedImportRow = Record<string, string>;

export type ParsedImportFile = {
  headers: string[];
  rows: ParsedImportRow[];
};

/**
 * KatanaService Standard Import Format（.xlsx / .csv）を読み込み、
 * ヘッダー行と各データ行（システム名キー→文字列値）に変換する。
 * 数値・日付もすべて文字列として取り出し、以降の検証ロジックで
 * CSV/Excelの差異を意識しなくてよいようにする。
 */
export async function parseImportFile(file: File): Promise<ParsedImportFile> {
  const isCsv = file.name.toLowerCase().endsWith(".csv");

  const workbook = isCsv
    ? XLSX.read(await file.text(), { type: "string" })
    : XLSX.read(await file.arrayBuffer(), { type: "array" });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { headers: [], rows: [] };
  }

  const sheet = workbook.Sheets[sheetName];

  const headerRow = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    blankrows: false,
  })[0];
  const headers = (headerRow ?? []).map((h) => String(h).trim());

  const rows = XLSX.utils.sheet_to_json<ParsedImportRow>(sheet, {
    defval: "",
    raw: false,
    blankrows: false,
  });

  return { headers, rows };
}
