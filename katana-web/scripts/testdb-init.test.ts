import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// テスト専用DBの初期化スクリプト（docker/test-db/init/）を、ファイルの内容だけで確かめる。Docker・DBには接続しない
// 目的：初期化のSQLが失敗しても、パスワードがサーバーのログ（docker logs）・psql の出力・プロセスの引数に出ないこと
const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const APP_ROLE = read("docker/test-db/init/01-app-role.sh");
const MARKER = read("docker/test-db/init/02-marker.sql");
const COMPOSE = read("docker-compose.test.yml");

// コメント行を除いた、実際に実行される行
const codeLines = (source: string, comment: string) =>
  source.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith(comment));

const [shellPart, sqlPart] = APP_ROLE.split("<<'SQL'\n");
const sqlBody = sqlPart.slice(0, sqlPart.lastIndexOf("\nSQL"));
const psqlCommand = codeLines(shellPart, "#").find((line) => line.trimStart().startsWith("psql "));

describe("01-app-role.sh：シェルの部分", () => {
  it("失敗したら止まる（set -Eeuo pipefail・ON_ERROR_STOP）", () => {
    expect(codeLines(shellPart, "#")).toContain("set -Eeuo pipefail");
    expect(psqlCommand).toContain("-v ON_ERROR_STOP=1");
  });

  it("シェルのトレースを使わない", () => {
    expect(APP_ROLE.split("\n")[0]).toBe("#!/usr/bin/env bash");
    for (const line of codeLines(shellPart, "#")) {
      expect(line).not.toMatch(/\bset\s+(-[a-zA-Z]*x|-o\s+xtrace)/);
      expect(line).not.toMatch(/\bBASH_XTRACEFD\b/);
    }
  });

  it("パスワードを表示しない（環境変数の値を展開するのは、空かどうかの確認だけ）", () => {
    const references = codeLines(shellPart, "#").filter((line) => /\$\{?KATANA_TEST_DB_PASSWORD/.test(line));
    expect(references).toEqual(['if [ -z "${KATANA_TEST_DB_PASSWORD:-}" ]; then']);
    for (const line of codeLines(shellPart, "#")) {
      expect(line).not.toMatch(/\b(env|printenv|export\s+-p|declare\s+-p|set)\s*$/);
    }
  });

  it("psql は、ヒアドキュメントで SQL を受け取る1回だけで、パスワードを引数に渡さない", () => {
    expect(codeLines(shellPart, "#").filter((line) => /\bpsql\b/.test(line))).toHaveLength(1);
    expect(APP_ROLE).toContain(`${psqlCommand}<<'SQL'\n`);
    expect(psqlCommand).not.toMatch(/PASSWORD|app_password|--set|\s-v\s+app/i);
  });

  it("psql の ECHO を使わず、エラー表示から文の抜粋を外す", () => {
    expect(psqlCommand).toContain("--no-psqlrc");
    expect(psqlCommand).toContain("-v VERBOSITY=terse");
    expect(psqlCommand).toContain("-v SHOW_CONTEXT=never");
    expect(psqlCommand).not.toMatch(/\s(-a|-e|-E|-b|--echo-[a-z]+|-L|--log-file)(\s|=|$)/);
    expect(psqlCommand).not.toMatch(/ECHO/);
  });
});

describe("01-app-role.sh：SQL の部分", () => {
  const sqlLines = codeLines(sqlBody, "--");
  const createRole = sqlLines.findIndex((line) => line.startsWith("CREATE ROLE "));

  it("パスワードを含む文は CREATE ROLE の1つだけで、値は psql の変数から渡す", () => {
    expect(createRole).toBeGreaterThan(-1);
    expect(sqlLines.filter((line) => /\bPASSWORD\b/i.test(line))).toEqual([sqlLines[createRole]]);
    expect(sqlLines[createRole]).toMatch(/ PASSWORD :'app_password';$/);
  });

  it("パスワードは \\getenv で環境変数から読み、CREATE ROLE より前に1回だけ設定する", () => {
    const getenv = sqlLines.filter((line) => line.includes("app_password") && line !== sqlLines[createRole]);
    expect(getenv).toEqual(["\\getenv app_password KATANA_TEST_DB_PASSWORD"]);
    expect(sqlLines.indexOf(getenv[0])).toBeLessThan(createRole);
  });

  it("CREATE ROLE より前に、文の全文をサーバーのログに出す設定を、このセッションだけ止める", () => {
    const before = sqlLines.slice(0, createRole);
    for (const setting of [
      "SET log_statement = 'none';",
      "SET log_min_error_statement = 'panic';",
      "SET log_min_duration_statement = -1;",
      "SET log_min_duration_sample = -1;",
    ]) {
      expect(before).toContain(setting);
    }
    // 途中で設定を戻したり、別のセッションに切り替えたりしない
    expect(sqlLines.some((line) => /^(RESET|\\c|\\connect|SET\s+(LOCAL\s+)?log_)/i.test(line) && !before.includes(line))).toBe(false);
  });

  it("psql の出力・エラー表示の設定を、SQL の中で変えない", () => {
    for (const line of sqlLines) {
      expect(line).not.toMatch(/^\\(set|o|out|echo|qecho|warn|getenv\s+(?!app_password\b))/);
    }
  });
});

describe("02-marker.sql・docker-compose.test.yml", () => {
  it("02-marker.sql は秘密情報を扱わない", () => {
    expect(MARKER).not.toMatch(/PASSWORD|KATANA_TEST_DB|getenv/i);
  });

  it("サーバーの起動オプションを変えない（ログの設定を command で上書きしない）", () => {
    expect(COMPOSE).not.toMatch(/^\s*(command|entrypoint):/m);
    expect(COMPOSE).not.toMatch(/log_statement|log_min_error_statement|POSTGRES_INITDB_ARGS/);
  });
});
