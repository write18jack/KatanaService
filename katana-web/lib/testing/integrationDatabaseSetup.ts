import { assertIntegrationRuntimeEnv, type IntegrationRuntimeFiles } from "./integrationEnv.ts";
import { IntegrationDatabaseCheckError } from "./integrationDatabaseCheck.ts";
import { serverIdentityChanges, serverIdentityMismatches } from "./testDbIdentity.ts";
import type { TestDatabaseInspection } from "./testDbState.ts";

/**
 * 統合テストの globalSetup の本体（Step 4-3）。lib/testing/integrationGlobalSetup.ts が、固定のゲートと実際の部品を渡して呼ぶ。
 *
 * このモジュールは DB ドライバ・Docker・子プロセスを読み込まない。DB への接続と状態の判定は、呼び出し側が inspectDatabase として渡す
 * （globalSetup は lib/testing/testDbMigrate.ts の createTestDatabaseInspector と lib/testing/testDbConnection.ts の connectTestDatabase）。
 * そのため、単体テストでは偽の関数だけで検証できる。
 *
 * 順序（最初の失敗で止まる。フォールバック・再試行はしない）:
 * 1. `.env.test`・`.env` を読み、接続前の検証（assertIntegrationRuntimeEnv。R14-1）
 * 2. 第7の固定ゲート（integrationDatabase）。無効なら、ここで INTEGRATION_DATABASE_LIVE_DISABLED で止まる（inspectDatabase を呼ばない）
 * 3. inspectDatabase（1回だけ接続し、`BEGIN READ ONLY` → search_path を pg_catalog に固定 → 本人確認 → 権限 →
 *    サーバーの識別情報 → 状態 A・B・C の判定 → ROLLBACK → 接続を閉じる。lib/testing/testDbState.ts の inspectTestDatabase）
 * 4. 状態 C であること（A・B・それ以外は拒否）と、サーバーの内部ポートが想定どおりであること
 * 5. teardown を返す。テストの終了後にもう一度 inspectDatabase を呼び、サーバーの識別情報が開始時と完全に一致し、
 *    状態 C（テストデータが残っていない）であることを確かめる。
 *
 * どの段階でも、DB を変更しない（TRUNCATE・DELETE・DROP・migration・reset・Docker の操作をしない）。
 * teardown が失敗しても、復旧のための書き込みはしない。失敗として報告するだけ。
 * エラーのメッセージには、接続URL・パスワード・ドライバの元のメッセージを含めない（コードと、テーブル名などの判定の理由だけ）。
 */

/**
 * 統合テストの実DBへの接続の許可（第7の固定ゲート）。lib/testing/integrationGlobalSetup.ts は INTEGRATION_DATABASE_DISABLED を固定で渡す。
 * 環境変数・引数では変えられない。有効にするには、承認を得て globalSetup のコードを変え、commit する（既存の6つのゲートと同じ運用）。
 */
export type IntegrationDatabaseAccess = { readonly mode: "disabled" } | { readonly mode: "enabled" };
export const INTEGRATION_DATABASE_DISABLED: IntegrationDatabaseAccess = Object.freeze({ mode: "disabled" });

export type IntegrationSetupErrorCode =
  | "INTEGRATION_DATABASE_LIVE_DISABLED"
  | "INTEGRATION_INSPECTION_FAILED"
  | "INTEGRATION_STATE_NOT_C"
  | "INTEGRATION_SERVER_IDENTITY_MISMATCH"
  | "INTEGRATION_TEARDOWN_INSPECTION_FAILED"
  | "INTEGRATION_TEARDOWN_SERVER_CHANGED"
  | "INTEGRATION_TEARDOWN_STATE_NOT_C";

export class IntegrationSetupError extends Error {
  readonly code: IntegrationSetupErrorCode;

  constructor(code: IntegrationSetupErrorCode, detail: string) {
    super(`[integrationGlobalSetup] ${code}: ${detail}`);
    this.name = "IntegrationSetupError";
    this.code = code;
  }
}

/** 検証済みの接続URLで1回だけ接続し、状態とサーバーの識別情報を読む（DBは変更しない） */
export type InspectIntegrationDatabase = (input: { databaseUrl: string; developmentDatabaseUrl: string | undefined }) => Promise<TestDatabaseInspection>;

export type IntegrationGlobalSetupDeps = {
  /** 検査するプロセスの環境変数（globalSetup では process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** `.env.test`・`.env` を読む（globalSetup では readIntegrationRuntimeFiles(process.cwd())） */
  readFiles: () => IntegrationRuntimeFiles;
  /** 第7の固定ゲート。globalSetup は INTEGRATION_DATABASE_DISABLED を固定で渡す */
  integrationDatabase: IntegrationDatabaseAccess;
  /** ゲートが有効なときだけ呼ぶ */
  inspectDatabase: InspectIntegrationDatabase;
};

/** テストの終了後に Vitest が呼ぶ（globalSetup の戻り値） */
export type IntegrationTeardown = () => Promise<void>;

/** 検査の失敗を、表示してよいコードだけを含むエラーに置き換える（元のメッセージは使わない） */
async function inspect(deps: IntegrationGlobalSetupDeps, input: Parameters<InspectIntegrationDatabase>[0], failure: IntegrationSetupErrorCode) {
  try {
    return await deps.inspectDatabase(input);
  } catch (error) {
    const code = error instanceof IntegrationDatabaseCheckError ? error.code : "unknown";
    throw new IntegrationSetupError(failure, `the read-only inspection of the test database failed (${code}). Nothing was changed or repaired.`);
  }
}

/** 状態 C でなければ、理由（テーブル名などで、値は含まない）を付けて拒否する */
function requireStateC(inspection: TestDatabaseInspection, failure: IntegrationSetupErrorCode, advice: string): void {
  const { state } = inspection;
  if (state.state === "C") return;
  const reasons = state.state === "B" ? state.reasons : state.state === "A" ? ["no migrations are applied"] : ["unknown state"];
  throw new IntegrationSetupError(failure, `the test database is in state ${String(state.state)}, not C (${reasons.join("; ")}). ${advice}`);
}

export async function runIntegrationGlobalSetup(deps: IntegrationGlobalSetupDeps): Promise<IntegrationTeardown> {
  // 1：接続前の検証。成功したら、env の DATABASE_URL は `.env.test` の値と完全に一致し、テストDBを指している
  const files = deps.readFiles();
  assertIntegrationRuntimeEnv(deps.env, files);

  // 2：第7の固定ゲート。「enabled」と完全に一致しなければ、接続の部品を一切呼ばない
  if (deps.integrationDatabase.mode !== "enabled") {
    throw new IntegrationSetupError(
      "INTEGRATION_DATABASE_LIVE_DISABLED",
      "the integration database gate is disabled in this build; refusing to start integration tests.",
    );
  }

  const target = { databaseUrl: deps.env.DATABASE_URL as string, developmentDatabaseUrl: files.developmentEnv?.DATABASE_URL };

  // 3・4：開始前の検査
  const before = await inspect(deps, target, "INTEGRATION_INSPECTION_FAILED");
  requireStateC(
    before,
    "INTEGRATION_STATE_NOT_C",
    "Integration tests did not start. Do not delete rows; recreate the test database through the approved procedure.",
  );
  const mismatches = serverIdentityMismatches(before.server);
  if (mismatches.length > 0) {
    throw new IntegrationSetupError("INTEGRATION_SERVER_IDENTITY_MISMATCH", `the server identity is unexpected (${mismatches.join("; ")}).`);
  }
  const startServer = { ...before.server };

  // 5：teardown。同じ接続先をもう一度読み取り専用で検査する（DBは変更しない）
  return async () => {
    const after = await inspect(deps, target, "INTEGRATION_TEARDOWN_INSPECTION_FAILED");
    // サーバーが入れ替わっていれば（再起動・コンテナの作り直し）、状態の比較に意味がないので先に報告する
    const changes = serverIdentityChanges(startServer, after.server);
    if (changes.length > 0) {
      throw new IntegrationSetupError(
        "INTEGRATION_TEARDOWN_SERVER_CHANGED",
        `the test database server changed during the run (${changes.join(", ")}). The results are not trustworthy. Nothing was repaired.`,
      );
    }
    requireStateC(
      after,
      "INTEGRATION_TEARDOWN_STATE_NOT_C",
      "Test data was left behind (a cleanup defect). Nothing was deleted; the next run will refuse to start until the test database is recreated with approval.",
    );
  };
}
