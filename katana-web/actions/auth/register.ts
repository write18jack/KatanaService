"use server";

/**
 * 自己登録は受け付けていない（docs/PLAN-authorization-fixes.md の案 C-1）。
 * Server Action は画面を通さずに直接呼べるため、ここで必ず止める。
 * 引数は読まず、何も検証・作成せずにエラーを返す。
 * 登録を再開するときは、承認の流れと一緒に改めて実装する。
 */
export async function registerUser(): Promise<{ error: string }> {
  return { error: "現在、新規登録は受け付けていません。" };
}
