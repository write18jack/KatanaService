import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildSchemaDiffCliArgs,
  DB_TARGET_ENV,
  DB_TARGET_TEST_READ_ONLY,
  SCHEMA_DIFF_CLI_ENTRY,
  SCHEMA_DIFF_CONFIG_FILE,
  SCHEMA_DIFF_FIXED_ENV,
  SCHEMA_DIFF_RO_URL_SHA256_ENV,
  schemaDiffUrlSha256,
} from "../db/prismaCliGuard.ts";
import { inheritAllowedEnv, isInheritedEnvKey } from "./integrationEnv.ts";

/**
 * Prisma schema と、テストDBの実際の定義の差分の検証の部品（Step 3-12B-5B。Step 3-12B-5E-9A-9-2 で方式A に作り直した）。
 * 手順は lib/testing/testDbSchemaDiffRunner.ts、実際の入出力は scripts/testdb-schema-diff.mts。
 * このモジュールは純粋関数と、注入した spawn・kill だけを使う関数を持つ（child_process・DB ドライバ・Docker を直接読み込まない）。
 *
 * 方式A（9-1 で決定）：Prisma CLI の `migrate diff` を、katana_test_ro（SELECT だけのロール）の URL で実行する。
 *   node <root>/node_modules/prisma/build/index.js migrate diff --from-config-datasource --to-schema <root>/prisma/schema.prisma
 *     --exit-code --config <root>/prisma.schemadiff.config.ts
 * - `--script`・`--output`・`--from-/--to-migrations`・shadow DB は使わない。比較する側は実DBの読み取り（SchemaDatasource）、
 *   比較される側は schema.prisma（SchemaDatamodel）。
 * - 終了コード（--exit-code）：差分なし 0・エラー 1・差分あり 2。CLI は 0 以外のときだけ process.exit(exitCode) を呼び、例外は 1 にする。
 * - 子プロセスの環境変数には URL を入れない。URL の SHA-256 だけを渡し、設定ファイルが `.env.test.readonly` から読み直して照合する。
 *
 * **残余リスク（解消していない。9-1 で、ローカルの専用テストDBと最小権限の katana_test_ro に限って受け入れたもの）**：
 * CLI は設定ファイルの datasource.url を schema engine の起動引数 `--datasource <JSON>` に渡す。katana_test_ro のパスワードを含む
 * URL は engine のプロセス引数に出て、同じユーザー・root からは ps などで読める。CLI のプロセスのメモリにも入る。
 *
 * 9-0 の静的調査（prisma-engines 0c8ef2ce45c83248ab3df073180d5eda9e8be7a3）で確認した、diff の経路の DB への操作:
 * - 接続ごとに最初の1回、`SELECT EXISTS(pg_namespace …), version(), current_setting('server_version_num')`。スキーマ（URL に
 *   `?schema=` がなければ public）がなければ `CREATE SCHEMA` を実行する。状態 C では public があるので実行されない見込みで、
 *   実行されても katana_test_ro には CREATE がないので失敗する（ガードは `?schema=` を含む URL を拒否する）。
 * - PostgreSQL では SET・advisory lock・トランザクションの制御はしない（CockroachDB だけ）。カタログの読み取りは SELECT だけ。
 * 読み取り専用の保証の根拠は、katana_test_ro の権限（R1・R2 で確かめる）で、コマンド名ではない。
 */

/** migrate diff の終了を待つ上限。超えたらプロセスグループに SIGTERM を送り、SCHEMA_DIFF_KILL_GRACE_MS 後に SIGKILL を送る */
export const SCHEMA_DIFF_TIMEOUT_MS = 120_000;
export const SCHEMA_DIFF_KILL_GRACE_MS = 5_000;
/** CLI の終了の後、プロセスグループが消えたことを確かめる間隔（上限は SCHEMA_DIFF_KILL_GRACE_MS） */
export const SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS = 100;
/**
 * 中断（SIGINT・SIGTERM）を受けてから、後始末と事後の検査を待つ上限。超えたら（または2回目の中断で）プロセスグループに SIGKILL を送り、
 * 事後の検査を打ち切って終了コード 1 で終わる（DB が変わっていないことは保証しない）
 */
export const SCHEMA_DIFF_INTERRUPT_DEADLINE_MS = 60_000;
/** 返す CLI の出力の上限（文字数） */
export const SCHEMA_DIFF_MAX_OUTPUT = 8_000;
/** 受け取る CLI の出力の上限（標準出力・標準エラーのそれぞれ） */
export const SCHEMA_DIFF_MAX_CAPTURE = 64 * 1024;
const HIDDEN = "(hidden)";

/** schema engine の実体（@prisma/engines。CLI は環境変数の上書きがなければ getEnginesPath() の下のこのファイルを使う） */
export const SCHEMA_ENGINE_BINARY = path.join("node_modules", "@prisma", "engines", "schema-engine-darwin-arm64");
/** engine の実体があるプラットフォーム（これ以外では、照合する SHA-256 がないので起動しない） */
export const SCHEMA_DIFF_PLATFORM = Object.freeze({ platform: "darwin", arch: "arm64" });

/**
 * 起動の前に照合するファイルの SHA-256（Prisma 7.2.0。@prisma/engines-version 7.2.0-4.0c8ef2ce45c83248ab3df073180d5eda9e8be7a3）。
 * Prisma を更新したら、9-0 と同じ静的な調査をやり直してから、承認を得て値を変える。照合するのはこの2つだけで、
 * CLI が読み込むほかのファイル（@prisma/config・c12・jiti など）と node の実行ファイルは照合しない。
 */
export const SCHEMA_DIFF_BINARY_SHA256: Readonly<Record<"cli" | "engine", { readonly file: string; readonly sha256: string }>> = Object.freeze({
  cli: Object.freeze({ file: SCHEMA_DIFF_CLI_ENTRY, sha256: "90b17be676409448cfa9fd869bb43766c0eb6df402d355e75f5892fe7157c036" }),
  engine: Object.freeze({ file: SCHEMA_ENGINE_BINARY, sha256: "ecee33a560d22f13d561e383b53f4aa9f0c79fb21115693f98d730c9af5516d0" }),
});

/**
 * 固定のコマンドに現れてはならない引数（変更系のサブコマンド・SQL の出力・ファイルへの書き込み・shadow DB を使う入力）。
 * 照合は完全一致の配列で行うので、これは念のための二重の確認。
 */
export const FORBIDDEN_SCHEMA_DIFF_ARGS: ReadonlySet<string> = new Set([
  "deploy",
  "dev",
  "reset",
  "resolve",
  "push",
  "pull",
  "execute",
  "seed",
  "db",
  "generate",
  "--script",
  "--output",
  "-o",
  "--from-migrations",
  "--to-migrations",
  "--to-config-datasource",
  "--from-schema",
  "--from-empty",
  "--to-empty",
  "--shadow-database-url",
  "--from-url",
  "--to-url",
  "--schema",
  "--force",
  "--accept-data-loss",
  "--create-only",
]);

export type SchemaDiffErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "DOCKER_TARGET_ENV_PRESENT"
  | "TEST_ENV_MISSING"
  | "READ_ONLY_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "READ_ONLY_TARGET_REJECTED"
  | "READ_ONLY_CREDENTIALS_REJECTED"
  | "UNSAFE_PARENT_ENV"
  | "CHILD_ENV_REJECTED"
  | "REQUIRED_FILE_MISSING"
  | "PLATFORM_NOT_SUPPORTED"
  | "BINARY_HASH_MISMATCH"
  | "EXPECTATION_INVALID"
  | "MIGRATION_COUNT_MISMATCH"
  | "COMMAND_REJECTED"
  | "SCHEMA_DIFF_LIVE_DISABLED"
  | "DOCKER_IDENTITY_FAILED"
  | "DOCKER_IDENTITY_MISMATCH"
  | "STATE_CHECK_FAILED"
  | "SERVER_IDENTITY_MISMATCH"
  | "DATABASE_STATE_NOT_C"
  | "MIGRATION_LIST_MISMATCH"
  | "CATALOG_CHECK_FAILED"
  | "ROLE_NOT_CREATED"
  | "CATALOG_STATE_MISMATCH"
  | "ACL_CHECK_FAILED"
  | "ACL_MISMATCH"
  | "READ_ONLY_ROLE_CHECK_FAILED"
  | "READ_ONLY_NOT_ENFORCED"
  | "INTERRUPTED";

export class SchemaDiffError extends Error {
  readonly code: SchemaDiffErrorCode;

  constructor(code: SchemaDiffErrorCode, detail: string) {
    super(`[schemaDiff] ${code}: ${detail}`);
    this.name = "SchemaDiffError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

// ---- 固定のゲート ----

/**
 * schemaDiff 用の実DB・Docker・Prisma CLI への到達の許可（固定のゲート）。migration・checksum・catalog・ro-role のゲートとは別の型・別の値。
 * scripts/testdb-schema-diff.mts は SCHEMA_DIFF_DISABLED を固定で渡す（環境変数・引数では変えられない。`--live` も許可を与えない）。
 * 有効にするのは、承認を得た後続の工程で、スクリプトのコードを変えたときだけ。
 */
export type SchemaDiffAccess = { readonly mode: "disabled" } | { readonly mode: "enabled-ro-schema-diff" };
export const SCHEMA_DIFF_DISABLED: SchemaDiffAccess = Object.freeze({ mode: "disabled" });

// ---- 固定のコマンド ----

export type SchemaDiffSpawnOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  /** 新しいプロセスグループで起動する（タイムアウトのとき、CLI と、CLI が起動した schema engine をまとめて止めるため） */
  readonly detached: true;
  /** 標準入力は渡さない。出力は伏せてから表示するため、受け取る */
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly groupCheckIntervalMs: number;
};

export type SchemaDiffCommand = {
  readonly command: string;
  readonly args: readonly string[];
};

/** 固定のコマンドを組み立てる（純粋関数。引数を追加する経路はない。設定ファイルの照合と同じ buildSchemaDiffCliArgs を使う） */
export function buildSchemaDiffCommand(input: { root: string; execPath: string }): SchemaDiffCommand {
  return Object.freeze({ command: input.execPath, args: buildSchemaDiffCliArgs(input.root) });
}

/** 子プロセスの起動オプション（shell: false・detached: true 固定） */
export function buildSchemaDiffSpawnOptions(root: string, childEnv: Readonly<Record<string, string>>): SchemaDiffSpawnOptions {
  return Object.freeze({
    cwd: root,
    env: Object.freeze({ ...childEnv }),
    shell: false,
    detached: true,
    stdio: Object.freeze(["ignore", "pipe", "pipe"] as const),
    timeoutMs: SCHEMA_DIFF_TIMEOUT_MS,
    killGraceMs: SCHEMA_DIFF_KILL_GRACE_MS,
    groupCheckIntervalMs: SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS,
  });
}

/** 固定のコマンドと完全に一致し、禁止された引数を含まないこと（違えば起動しない） */
export function assertSchemaDiffCommand(candidate: SchemaDiffCommand, expected: SchemaDiffCommand): void {
  const sameArgs = candidate.args.length === expected.args.length && candidate.args.every((arg, i) => arg === expected.args[i]);
  if (candidate.command !== expected.command || !sameArgs) {
    throw new SchemaDiffError("COMMAND_REJECTED", "the Prisma CLI command is not the fixed migrate diff command; the Prisma CLI was not started.");
  }
  if (candidate.args.some((arg) => FORBIDDEN_SCHEMA_DIFF_ARGS.has(arg) || /^--(script|output|shadow)/.test(arg))) {
    throw new SchemaDiffError("COMMAND_REJECTED", "the Prisma CLI command contains a forbidden argument; the Prisma CLI was not started.");
  }
  const configs = candidate.args.filter((arg) => path.basename(arg) === SCHEMA_DIFF_CONFIG_FILE);
  if (configs.length !== 1 || candidate.args.some((arg) => path.basename(arg) === "prisma.config.ts")) {
    throw new SchemaDiffError("COMMAND_REJECTED", "the Prisma CLI command must use only the schema diff config file; the Prisma CLI was not started.");
  }
}

// ---- 子プロセスの環境変数 ----

/**
 * 子プロセス（Prisma CLI。engine は CLI の環境変数から PWD を除いたものを引き継ぐ）の環境変数を作る。
 * 親からは許可リスト（inheritAllowedEnv）だけを引き継ぎ、接続先モード・URL の SHA-256・固定の値（CHECKPOINT_DISABLE=1・CI=1・
 * RUST_LOG・RUST_BACKTRACE）を設定する。URL・パスワード・DATABASE_URL・PRISMA_*・DEBUG・NODE_*・PG*・DOTENV_* は入れない。
 */
export function buildSchemaDiffEnv(parentEnv: EnvSource, verifiedReadOnlyUrl: string): { childEnv: Record<string, string>; droppedKeys: string[] } {
  const { inherited, droppedKeys } = inheritAllowedEnv(parentEnv);
  return {
    childEnv: {
      ...inherited,
      ...SCHEMA_DIFF_FIXED_ENV,
      [DB_TARGET_ENV]: DB_TARGET_TEST_READ_ONLY,
      [SCHEMA_DIFF_RO_URL_SHA256_ENV]: schemaDiffUrlSha256(verifiedReadOnlyUrl),
    },
    droppedKeys,
  };
}

/** 子プロセスの環境変数の最終的な値を検証する（名前は許可リストだけ・固定の値・秘密の値や接続URLを含まない）。違反の説明（名前だけ）を返す */
export function schemaDiffEnvViolations(childEnv: Readonly<Record<string, string>>, verifiedReadOnlyUrl: string, secrets: readonly string[]): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(childEnv).sort()) {
    const allowed = isInheritedEnvKey(key) || Object.hasOwn(SCHEMA_DIFF_FIXED_ENV, key) || key === DB_TARGET_ENV || key === SCHEMA_DIFF_RO_URL_SHA256_ENV;
    if (!allowed) violations.push(`${key} is not allowed`);
    const value = childEnv[key];
    if (/postgres(ql)?:/i.test(value) || secrets.some((secret) => secret !== "" && value.includes(secret))) violations.push(`${key} contains a connection URL or a secret`);
  }
  for (const [key, value] of Object.entries(SCHEMA_DIFF_FIXED_ENV)) if (childEnv[key] !== value) violations.push(`${key} is not ${value}`);
  if (childEnv[DB_TARGET_ENV] !== DB_TARGET_TEST_READ_ONLY) violations.push(`${DB_TARGET_ENV} is not ${DB_TARGET_TEST_READ_ONLY}`);
  if (childEnv[SCHEMA_DIFF_RO_URL_SHA256_ENV] !== schemaDiffUrlSha256(verifiedReadOnlyUrl)) violations.push(`${SCHEMA_DIFF_RO_URL_SHA256_ENV} does not match the verified URL`);
  return violations;
}

// ---- CLI・engine の SHA-256 ----

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * CLI のエントリと schema engine の実体の SHA-256 を、固定の値と照合する（違えば起動しない）。
 * プラットフォームが darwin-arm64 でなければ、照合する値がないので止める。読むだけで、実行はしない。
 * 照合の後、起動までの間にファイルが差し替えられることは防げない（TOCTOU。runner は起動の直前にもう一度照合する）。
 */
export function assertSchemaDiffBinaries(input: { root: string; platform: string; arch: string; readBinary: (absolutePath: string) => Uint8Array }): void {
  if (input.platform !== SCHEMA_DIFF_PLATFORM.platform || input.arch !== SCHEMA_DIFF_PLATFORM.arch) {
    throw new SchemaDiffError("PLATFORM_NOT_SUPPORTED", `the schema engine hash is pinned only for ${SCHEMA_DIFF_PLATFORM.platform}-${SCHEMA_DIFF_PLATFORM.arch}; the Prisma CLI was not started.`);
  }
  for (const [name, { file, sha256 }] of Object.entries(SCHEMA_DIFF_BINARY_SHA256)) {
    let actual: string;
    try {
      actual = sha256OfBytes(input.readBinary(path.join(input.root, file)));
    } catch {
      throw new SchemaDiffError("BINARY_HASH_MISMATCH", `${file} (${name}) could not be read; the Prisma CLI was not started.`);
    }
    if (actual !== sha256) {
      throw new SchemaDiffError("BINARY_HASH_MISMATCH", `${file} (${name}) does not match the pinned SHA-256; the Prisma CLI was not started.`);
    }
  }
}

// ---- 終了コードの分類 ----

/**
 * CLI のプロセスグループの後始末の結果。stopped：CLI の終了（close）を受け、グループに残ったプロセスがないことを確かめた。
 * not-confirmed：CLI の終了を受けられなかったか、上限までにグループが消えたことを確かめられなかった（engine などが残っているかもしれない）
 */
export type SchemaDiffProcessGroupState = "stopped" | "not-confirmed";

/**
 * spawnCapture の結果。exit：終了した（code か signal のどちらか）。spawn-error：起動できなかった。timeout：上限を超えて止めた。
 * interrupted：親のプロセスが SIGINT・SIGTERM を受けて止めた
 */
export type SchemaDiffProcessResult =
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly processGroup: SchemaDiffProcessGroupState;
    }
  | { readonly kind: "spawn-error"; readonly errorCode: string }
  | { readonly kind: "timeout"; readonly stdout: string; readonly stderr: string; readonly processGroup: SchemaDiffProcessGroupState }
  | {
      readonly kind: "interrupted";
      readonly signal: SchemaDiffInterruptSignal;
      readonly stdout: string;
      readonly stderr: string;
      readonly processGroup: SchemaDiffProcessGroupState;
    };

/** no-diff だけが成功。diff（差分あり）と cli-error（実行エラー）は別に扱う */
export type SchemaDiffOutcome =
  | { readonly outcome: "no-diff" }
  | { readonly outcome: "diff"; readonly summary: string }
  | { readonly outcome: "cli-error"; readonly output: string }
  | { readonly outcome: "unexpected-exit"; readonly exitCode: number | null; readonly output: string }
  | { readonly outcome: "signal"; readonly signal: string }
  | { readonly outcome: "timeout"; readonly output: string }
  | { readonly outcome: "interrupted"; readonly signal: SchemaDiffInterruptSignal; readonly output: string }
  | { readonly outcome: "spawn-failed"; readonly errorCode: string };

/** 出力から接続URL・パスワードを伏せ、長さを制限する */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  // 先に、接続URL（知らないものを含む。認証情報を含み得る）のスキームから後ろを伏せ、その後で個別の値を伏せる
  let result = text.replace(/postgres(?:ql)?:\/\/[^\s"'`]*/gi, `postgresql://${HIDDEN}`);
  for (const secret of [...secrets].filter((s) => s !== "").sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join(HIDDEN);
  }
  return result.length > SCHEMA_DIFF_MAX_OUTPUT ? `${result.slice(0, SCHEMA_DIFF_MAX_OUTPUT)}\n… (output truncated)` : result;
}

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_SIGNAL = /^SIG[A-Z0-9]+$/;

/** 終了コードを分類する（純粋関数）。0：差分なし、1：CLI のエラー、2：差分あり、それ以外：想定外 */
export function classifySchemaDiffResult(result: SchemaDiffProcessResult, secrets: readonly string[]): SchemaDiffOutcome {
  if (result.kind === "spawn-error") {
    return { outcome: "spawn-failed", errorCode: SAFE_ERROR_CODE.test(result.errorCode) ? result.errorCode : "unknown" };
  }
  const output = redactSecrets([result.stdout, result.stderr].filter((s) => s !== "").join("\n"), secrets);
  if (result.kind === "interrupted") return { outcome: "interrupted", signal: result.signal, output };
  if (result.kind === "timeout") return { outcome: "timeout", output };
  if (result.signal !== null) return { outcome: "signal", signal: SAFE_SIGNAL.test(result.signal) ? result.signal : "unknown" };
  switch (result.code) {
    case 0:
      return { outcome: "no-diff" };
    case 1:
      return { outcome: "cli-error", output };
    case 2:
      return { outcome: "diff", summary: redactSecrets(result.stdout, secrets) };
    default:
      return { outcome: "unexpected-exit", exitCode: Number.isInteger(result.code) ? result.code : null, output };
  }
}

export function schemaDiffSucceeded(outcome: SchemaDiffOutcome): boolean {
  return outcome.outcome === "no-diff";
}

// ---- 中断（親のプロセスへの SIGINT・SIGTERM） ----

export type SchemaDiffInterruptSignal = "SIGINT" | "SIGTERM";
/** force：2回目の中断か、中断の後始末の上限（SCHEMA_DIFF_INTERRUPT_DEADLINE_MS）を超えた。直後にプロセスを終了する */
export type SchemaDiffInterruptEvent = { readonly signal: SchemaDiffInterruptSignal; readonly force: boolean };

/** 中断の状態と通知（runner と spawnCapture が使う） */
export type SchemaDiffInterrupts = {
  /** 最初に受けた中断のシグナル。受けていなければ undefined */
  readonly received: () => SchemaDiffInterruptSignal | undefined;
  /** 中断の通知を受ける。戻り値は解除 */
  readonly subscribe: (listener: (event: SchemaDiffInterruptEvent) => void) => () => void;
};

/** 中断を受けない（単体テストなど）。scripts/testdb-schema-diff.mts は createSchemaDiffInterruptController を使う */
export const NO_SCHEMA_DIFF_INTERRUPTS: SchemaDiffInterrupts = Object.freeze({
  received: () => undefined,
  subscribe: () => () => {},
});

export type SchemaDiffInterruptControllerDeps = {
  /** process.on(signal, handler)。ハンドラを登録すると、Node の既定の動作（即時の終了）は起きない */
  onSignal: (signal: SchemaDiffInterruptSignal, handler: () => void) => void;
  /** process.exit（force のときだけ） */
  forceExit: (code: number) => void;
  /** 上限のタイマー（プロセスの終了を妨げないもの。setTimeout(...).unref()） */
  setTimer: (callback: () => void, ms: number) => unknown;
  log: (text: string) => void;
  deadlineMs: number;
};

/**
 * 親のプロセスの SIGINT・SIGTERM を受ける。
 * - 1回目：記録し、通知する（CLI の起動前なら、runner が CLI を起動せずに止める。起動後なら、spawnCapture がプロセスグループに
 *   SIGTERM → SIGKILL を送り、runner が事後の検査 D3・F2・FP2・R2 を試す）。判定は no-diff・diff にならない。
 * - 2回目の中断か、1回目から deadlineMs を超えたとき：force を通知し（spawnCapture がグループに SIGKILL を送る）、
 *   事後の検査を打ち切って終了コード 1 で終了する。中断の処理そのものが無制限に止まらないための上限。
 * SIGKILL・電源断など、このプロセスが処理できない終了では、後始末はできない（残余リスク）。
 */
export function createSchemaDiffInterruptController(deps: SchemaDiffInterruptControllerDeps): SchemaDiffInterrupts {
  let received: SchemaDiffInterruptSignal | undefined;
  let forced = false;
  const listeners = new Set<(event: SchemaDiffInterruptEvent) => void>();
  const notify = (event: SchemaDiffInterruptEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 1つの後始末の失敗で、ほかの後始末と終了を止めない
      }
    }
  };
  const force = (signal: SchemaDiffInterruptSignal, reason: string) => {
    if (forced) return;
    forced = true;
    notify({ signal, force: true });
    deps.log(
      `[schemaDiff] ${reason}: sent SIGKILL to the Prisma CLI process group (if it was running) and abandoned the remaining checks. It is not guaranteed that the database is unchanged, and the process group may not have stopped.`,
    );
    deps.forceExit(1);
  };
  const handle = (signal: SchemaDiffInterruptSignal) => {
    if (received !== undefined) {
      force(signal, `${signal} received again`);
      return;
    }
    received = signal;
    deps.log(
      `[schemaDiff] ${signal} received: the Prisma CLI is not started, or its process group is stopped, and the checks after it are attempted; the result is not "no difference". Send the signal again to abandon them (limit ${deps.deadlineMs} ms).`,
    );
    notify({ signal, force: false });
    deps.setTimer(() => force(signal, `the interrupt handling exceeded ${deps.deadlineMs} ms`), deps.deadlineMs);
  };
  deps.onSignal("SIGINT", () => handle("SIGINT"));
  deps.onSignal("SIGTERM", () => handle("SIGTERM"));
  return Object.freeze({
    received: () => received,
    subscribe: (listener: (event: SchemaDiffInterruptEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

// ---- 子プロセスの起動（プロセスグループごと止める） ----

type DataStream = { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
/** node:child_process の ChildProcess のうち、使う部分だけ */
export type SchemaDiffChild = {
  readonly pid?: number;
  readonly stdout: DataStream | null;
  readonly stderr: DataStream | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
};

export type SchemaDiffProcessDeps = {
  /** node:child_process の spawn（shell なし・detached・stdio は options のまま渡す） */
  spawn: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; shell: false; detached: true; stdio: ["ignore", "pipe", "pipe"] },
  ) => SchemaDiffChild;
  /** プロセスグループ全体にシグナルを送る（process.kill(-pgid, signal)）。グループがなければ throw してよい（無視する） */
  killGroup: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** プロセスグループにプロセスが残っているか（process.kill(-pgid, 0)。ESRCH なら false）。throw したら「残っている」とみなす */
  groupExists: (pgid: number) => boolean;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

type StopReason = { readonly kind: "timeout" } | { readonly kind: "interrupted"; readonly signal: SchemaDiffInterruptSignal };

/**
 * 固定のコマンドを shell なし・新しいプロセスグループで起動し、出力と終了を返す関数を作る。
 * - timeoutMs を超えたとき、または中断（interrupts の1回目）を受けたとき：グループ全体（CLI と、CLI が起動した schema engine）に
 *   SIGTERM、killGraceMs 後に SIGKILL を送る。さらに killGraceMs 待っても CLI が終わらなければ、processGroup: not-confirmed で返す。
 * - 中断の force（2回目・上限超え）を受けたとき：すぐにグループに SIGKILL を送る。
 * - CLI が終わった（close）後：グループに残ったプロセス（engine など）に SIGKILL を送り、グループが消えたことを groupCheckIntervalMs ごとに
 *   確かめる（上限 killGraceMs）。確かめられれば stopped、そうでなければ not-confirmed。
 * - 返すのは、CLI の終了とグループの確認の後（または上限の後）。待ち時間には上限があり、無制限には止まらない。
 * - 起動の前に中断を受けていたら、起動しない（spawn-error: INTERRUPTED）。
 */
export function createSchemaDiffSpawnCapture(
  deps: SchemaDiffProcessDeps,
): (command: string, args: readonly string[], options: SchemaDiffSpawnOptions, interrupts?: SchemaDiffInterrupts) => Promise<SchemaDiffProcessResult> {
  return (command, args, options, interrupts = NO_SCHEMA_DIFF_INTERRUPTS) =>
    new Promise((resolve) => {
      if (options.shell !== false || options.detached !== true) {
        resolve({ kind: "spawn-error", errorCode: "OPTIONS_REJECTED" });
        return;
      }
      if (interrupts.received() !== undefined) {
        resolve({ kind: "spawn-error", errorCode: "INTERRUPTED" });
        return;
      }
      let stdout = "";
      let stderr = "";
      let stopReason: StopReason | undefined;
      let closeInfo: { code: number | null; signal: string | null } | undefined;
      let settled = false;
      const stopTimers: unknown[] = [];
      const checkTimers: unknown[] = [];
      let unsubscribe: () => void = () => {};
      const finish = (result: SchemaDiffProcessResult) => {
        if (settled) return;
        settled = true;
        for (const timer of [...stopTimers, ...checkTimers]) deps.clearTimer(timer);
        // グループの停止を確かめられなかったときは、中断の force（SIGKILL）を受けられるように購読を残す
        if (result.kind === "spawn-error" || result.processGroup === "stopped") unsubscribe();
        resolve(result);
      };
      let child: SchemaDiffChild;
      try {
        child = deps.spawn(command, [...args], { cwd: options.cwd, env: { ...options.env }, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        finish({ kind: "spawn-error", errorCode: typeof code === "string" ? code : "unknown" });
        return;
      }
      const pgid = child.pid;
      const validGroup = pgid !== undefined && Number.isInteger(pgid) && pgid > 1;
      const sendToGroup = (signal: "SIGTERM" | "SIGKILL") => {
        if (!validGroup) return;
        try {
          deps.killGroup(pgid, signal);
        } catch {
          // グループが既にない（ESRCH）など
        }
      };
      const groupGone = (): boolean => {
        if (!validGroup) return false;
        try {
          return !deps.groupExists(pgid);
        } catch {
          return false;
        }
      };
      const resultWith = (processGroup: SchemaDiffProcessGroupState): SchemaDiffProcessResult => {
        if (stopReason?.kind === "interrupted") return { kind: "interrupted", signal: stopReason.signal, stdout, stderr, processGroup };
        if (stopReason?.kind === "timeout") return { kind: "timeout", stdout, stderr, processGroup };
        return { kind: "exit", code: closeInfo?.code ?? null, signal: closeInfo?.signal ?? null, stdout, stderr, processGroup };
      };
      const beginStop = (reason: StopReason) => {
        if (stopReason !== undefined || closeInfo !== undefined || settled) return;
        stopReason = reason;
        sendToGroup("SIGTERM");
        stopTimers.push(
          deps.setTimer(() => {
            sendToGroup("SIGKILL");
            // SIGKILL の後も CLI の終了を受けられなければ、確認できなかったものとして返す（無制限には待たない）
            stopTimers.push(deps.setTimer(() => finish(resultWith("not-confirmed")), options.killGraceMs));
          }, options.killGraceMs),
        );
      };
      unsubscribe = interrupts.subscribe((event) => {
        if (event.force) sendToGroup("SIGKILL");
        else beginStop({ kind: "interrupted", signal: event.signal });
      });

      child.stdout?.on("data", (chunk) => {
        if (stdout.length < SCHEMA_DIFF_MAX_CAPTURE) stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < SCHEMA_DIFF_MAX_CAPTURE) stderr += chunk.toString();
      });
      child.on("error", (error) => {
        // 起動できなかった（pid がない）ときだけ、ここで返す。起動後のエラー（シグナルの送信の失敗など）は close を待つ
        if (pgid === undefined) {
          const code = (error as { code?: unknown }).code;
          finish({ kind: "spawn-error", errorCode: typeof code === "string" ? code : "unknown" });
        }
      });
      child.on("close", (code, signal) => {
        if (settled || closeInfo !== undefined) return;
        closeInfo = { code, signal };
        for (const timer of stopTimers) deps.clearTimer(timer);
        // CLI の終了後、グループに残ったもの（engine など）を止め、グループが消えたことを確かめる（上限 killGraceMs）
        sendToGroup("SIGKILL");
        let waited = 0;
        const check = () => {
          if (groupGone()) {
            finish(resultWith("stopped"));
            return;
          }
          if (waited >= options.killGraceMs) {
            finish(resultWith("not-confirmed"));
            return;
          }
          waited += Math.max(1, options.groupCheckIntervalMs);
          sendToGroup("SIGKILL");
          checkTimers.push(deps.setTimer(check, options.groupCheckIntervalMs));
        };
        check();
      });
      if (pgid !== undefined) stopTimers.push(deps.setTimer(() => beginStop({ kind: "timeout" }), options.timeoutMs));
    });
}

// ---- 比較の範囲（報告に必ず添える） ----

/**
 * 終了コード 0 の意味と、比較の範囲（9-0 の静的調査。prisma-engines 0c8ef2ce の sql-schema-describer・sql_schema_differ）。
 * 「差分なし」は、PostgreSQL のすべての定義が一致したことを意味しない。
 */
export const SCHEMA_DIFF_SCOPE_NOTE: readonly string[] = Object.freeze([
  "exit code 0 means: no difference within what Prisma compares (not that every PostgreSQL definition matches).",
  "excluded by Prisma: the _prisma_migrations table (MIGRATIONS_TABLE_NAME) and PostGIS tables.",
  "compared: tables; column types (with native type arguments), nullability/arity, defaults (with exceptions), autoincrement; primary keys; foreign keys (columns, referenced table, ON DELETE/UPDATE, names); indexes (columns, order, sort, length, unique, algorithm, opclass, names); extensions (name, version, schema).",
  "not compared: column order, collation, identity/generated details, CHECK/EXCLUDE expressions, partial index predicates (partial indexes are not read), INCLUDE columns, NULLS NOT DISTINCT, unique constraint vs unique index, NOT VALID, MATCH type, owners and ACLs.",
  "defaults: DateTime value defaults and some JSON defaults are treated as equal; Timestamp without precision equals Timestamp(6).",
  "unconfirmed: whether DEFERRABLE/DEFERRED, comments and enum values are compared by Prisma.",
  "complemented elsewhere: enum values and order, CHECK/EXCLUDE/constraint triggers = 0, partial/expression indexes = 0, row security, owners and ACLs (catalog audit, FP1/FP2, A1); column order/collation/identity/generated, deferrable/validated and index definitions are only compared before/after (FP1/FP2), not against expected values.",
]);
