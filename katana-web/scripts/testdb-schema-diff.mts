/**
 * Prisma schema とテストDBの定義の差分の検証（schemaDiff。Step 3-12B-5E-9A-9-2。方式A：Prisma CLI と専用の設定ファイル）。
 *
 *   npm run testdb:schema-diff                 … 予行（引数なし）。事前の検証と、実行予定のコマンドの表示だけ（Docker・DB・Prisma CLI に触れない）
 *   node scripts/testdb-schema-diff.mts --live … 実行の意思表示。固定のゲートは一時的に有効（Step 3-12B-5E-9A-9-5）なので、--live は
 *                                                ランナーの検証を通れば Prisma CLI の起動まで進む（実行は別の承認を得てから。Step 9-6）
 *
 * 手順と検証の内容は lib/testing/testDbSchemaDiffRunner.ts・lib/testing/schemaDiff.ts。このファイルは、実際の入出力をつなぐだけ。
 * ゲートは固定の値（環境変数・引数では変えられない）。今は一時的に有効の固定値 { mode: "enabled-ro-schema-diff" }（Step 3-12B-5E-9A-9-5）で、
 * Step 9-8 で SCHEMA_DIFF_DISABLED に戻す予定。変えるのは、承認を得た工程で、このファイルを変えたときだけ。ゲートの有効化と実行（--live）は、別々に承認を得る。
 *
 * Prisma CLI の起動（createSchemaDiffSpawnCapture）は、shell なし・新しいプロセスグループ（detached）・標準入力なし。
 * タイムアウトでは、CLI と、CLI が起動した schema engine をプロセスグループごと止める。出力は伏せてから表示する。
 * 中断（このプロセスへの SIGINT・SIGTERM）は createSchemaDiffInterruptController で受ける。CLI の起動前なら起動せずに止め、起動後なら
 * プロセスグループに SIGTERM → SIGKILL を送って終了を確かめ、事後の検査を試す（判定は interrupted。終了コード 1）。2回目の中断か、
 * SCHEMA_DIFF_INTERRUPT_DEADLINE_MS を超えたら、グループに SIGKILL を送り、事後の検査を打ち切って終了コード 1 で終わる。
 * 終了コード：0 差分なし（Prisma が比較できる範囲）・2 差分あり・1 それ以外（実行の失敗・事後の検査の失敗・事前の検証での停止）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import {
  createSchemaDiffInterruptController,
  createSchemaDiffSpawnCapture,
  SCHEMA_DIFF_INTERRUPT_DEADLINE_MS,
  SchemaDiffError,
} from "../lib/testing/schemaDiff.ts";
import { loadCatalogAuditExpectation, runCatalogDefinitionAudit } from "../lib/testing/testDbCatalogAudit.ts";
import { connectTestDatabase } from "../lib/testing/testDbConnection.ts";
import { readTestDbDockerIdentity, runDockerCommand } from "../lib/testing/testDbDocker.ts";
import { createTestDatabaseInspector } from "../lib/testing/testDbMigrate.ts";
import { ReadOnlyRoleError, runPreChangeAclCheck, runReadOnlyRoleCheck } from "../lib/testing/testDbReadOnlyRole.ts";
import { runTestDbSchemaDiff } from "../lib/testing/testDbSchemaDiffRunner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 最初に登録する（登録の後は、SIGINT・SIGTERM でこのプロセスがすぐには終わらず、後始末と事後の検査を試す）
const interrupts = createSchemaDiffInterruptController({
  onSignal: (signal, handler) => {
    process.on(signal, handler);
  },
  forceExit: (code) => process.exit(code),
  setTimer: (callback, ms) => setTimeout(callback, ms).unref(),
  log: (text) => console.error(text),
  deadlineMs: SCHEMA_DIFF_INTERRUPT_DEADLINE_MS,
});

const spawnCapture = createSchemaDiffSpawnCapture({
  spawn: (command, args, options) => spawn(command, args, { ...options, env: options.env as NodeJS.ProcessEnv }),
  killGroup: (pgid, signal) => {
    process.kill(-pgid, signal);
  },
  groupExists: (pgid) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      // ESRCH：グループにプロセスがない。EPERM などは「残っている」とみなす
      return (error as { code?: unknown }).code !== "ESRCH";
    }
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

runTestDbSchemaDiff({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  execPath: process.execPath,
  platform: process.platform,
  arch: process.arch,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  readBinary: (absolutePath) => readFileSync(absolutePath),
  loadExpectation: () => loadCatalogAuditExpectation(ROOT),
  // schemaDiff の実DB・Docker・Prisma CLI への到達の許可は、一時的に有効（固定。Step 3-12B-5E-9A-9-5。Step 9-8 で SCHEMA_DIFF_DISABLED に戻す）。
  // 引数なし（予行）では、これまでどおり Docker・DB・CLI に触れない。--live のときだけ、ランナーの検証の後で D1 以降に進む
  access: { mode: "enabled-ro-schema-diff" },
  readDockerIdentity: (input) => readTestDbDockerIdentity({ ...input, run: runDockerCommand }),
  inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),
  runAudit: (input) => runCatalogDefinitionAudit({ ...input, connect: connectTestDatabase }),
  checkReadOnlyRole: (input) => runReadOnlyRoleCheck({ ...input, connect: connectTestDatabase }),
  checkAcl: (input) => runPreChangeAclCheck({ ...input, connect: connectTestDatabase }),
  spawnCapture,
  interrupts,
  log: (text) => console.log(text),
}).then(
  (outcome) => {
    // 中断を受けていたら、予行・判定の結果にかかわらず 1（中断を正常終了にしない）
    process.exitCode = interrupts.received() !== undefined ? 1 : outcome.mode === "dry-run" ? 0 : outcome.exitCode;
  },
  (error: unknown) => {
    // 想定したエラーは、秘密情報を含まないメッセージだけを表示する。想定外のエラーは、メッセージ（接続URLを含み得る）を表示せず、名前とコードだけ
    if (error instanceof SchemaDiffError || error instanceof ReadOnlyRoleError || error instanceof IntegrationRunnerError) {
      console.error(error.message);
    } else {
      const name = error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : "unknown";
      const code = (error as { code?: unknown } | null)?.code;
      console.error(`[schemaDiff] unexpected error (${name}${typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? `, ${code}` : ""}); details are not shown because they may contain connection data.`);
    }
    process.exitCode = 1;
  },
);
