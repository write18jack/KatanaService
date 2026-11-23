import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * DB接続を作るコードが、許可したファイルの外に増えていないことを静的に検証する。
 * ソースは TypeScript Compiler API で構文解析するだけで、検査対象のモジュールは import しない。
 *
 * 規則:
 * - prisma-client-constructor：`@prisma/client`（サブパス・`.prisma/client` を含む）の PrismaClient を値として参照する
 *   （new・extends・代入・引数・export など）。型の位置での参照、enum・`Prisma` 名前空間の利用は対象外。
 * - prisma-adapter-pg：`@prisma/adapter-pg` を参照する。
 * - pg-driver：`pg`（サブパス・`pg-pool`・`pg-native` を含む）を参照する。ALLOWED_PG_DRIVER_FILES のファイルでは、
 *   パッケージ名が完全に `pg` のものだけを許可する（サブパス・`pg-pool`・`pg-native` と、ほかの規則は許可しない）。
 * - legacy-generated-prisma：`lib/generated/prisma/` を参照する。許可リストのファイルでも禁止。
 * - db-module-reexport：`@/lib/prisma` の再export、PrismaClient・`@prisma/client` 全体の再export。
 * 「参照」は import・export … from・`import x = require()`・require()・import()・import 型・vi.importActual/importMock。
 *
 * 検出できない書き方（レビューで補う）:
 * - 文字列を組み立てた require・import（`import(name)`、`require("p" + "g")`）、createRequire・eval・new Function。
 * - 宣言を経由しない取得（`let m; m = await import(…)`、`import(…).then((m) => new m.PrismaClient())`、
 *   別モジュールの関数が返すコンストラクタ、globalThis に置かれたクライアント）。
 * - `@/lib/prisma` の値を別の変数に入れてから export する間接的な再export（`const db = prisma; export { db }`）。
 * - 許可リストのファイルの中身の変更、走査対象外（node_modules・lib/generated/prisma の中身・上記以外の拡張子）のコード、
 *   pg 以外のDBドライバ、Prisma CLI（prisma.config.ts）による接続。
 * - 束縛はスコープを区別しないため、同名のローカル変数で隠した場合も違反として扱う（安全側の誤検出）。
 *
 * 規則3（通常テストからの本物のPrisma。`*.integration.test.ts(x)` は対象外）:
 * - prisma-mock-without-factory：factory なしの `vi.mock`・`vi.doMock`（自動モックは本物のモジュールを評価する）。
 * - prisma-import-original：引数（importOriginal）を受け取る factory。
 * - prisma-mock-unverifiable-factory：factory が関数式でない（変数・`{ spy: true }` など）。
 * - prisma-import-actual：`vi.importActual`。
 * - prisma-unmock：`vi.unmock`・`vi.doUnmock`。
 * 対象は `@/lib/prisma` と、lib/prisma に解決される相対パス（拡張子付きを含む）。`vi.mock(import("…"))` の形も扱う。
 *
 * 規則4（テストの分類）: テストファイルから、ローカルの import 依存関係を AST で辿り、DB接続モジュール
 * （lib/prisma.ts・prisma/seed.ts・pg・`@prisma/adapter-pg`・古い生成コード）に到達するかを判定する。
 * - テストファイルで factory（引数なしの関数式）付きの `vi.mock` をしたモジュールは、辿らない（Vitest と同じく、
 *   依存先のどこから読み込まれてもモックになる）。`vi.importActual` は、そのモジュール自身だけ本物を辿る。
 * - 自動モック・importOriginal を受け取る factory・`vi.doMock`・`vi.unmock` のモジュールは、本物を辿る（安全側）。
 * - 通常テストがDBに到達したら違反。統合テストの名前なのにDBに到達しなくても違反（分類のずれ）。
 * - 静的に判定できない箇所（文字列以外の import()・require()・`vi.mock` のパス、解決できないローカルパス、
 *   eval・createRequire、テストファイル以外での `vi.mock`）は「未確認」として報告し、安全とはみなさない。
 * 規則4で検出できない書き方:
 * - パッケージ（node_modules）の中からローカルのファイルを読み込む経路。tsconfig の `@/*` 以外の別名、
 *   `/lib/prisma` のようなルートからの絶対パス（パッケージとして扱ってしまう）。
 * - setupFiles・globalSetup（vitest.config.ts に設定されていないことを別に検査する）。
 * - 実行時に条件分岐で読み込まれないコードも、読み込まれるものとして扱う（安全側の誤検出）。
 */
const ROOT = path.resolve(__dirname, "../..");
/** 接続を生成してよいファイル（リポジトリ相対のパスで完全一致） */
const ALLOWED_CONNECTION_FILES = new Set(["lib/prisma.ts", "prisma/seed.ts"]);
/**
 * `pg`（パッケージ名の完全一致）だけを直接 import してよいファイル（Step 3-10B。テストDBの読み取り専用の状態判定の接続）。
 * PrismaClient・@prisma/adapter-pg・pg のサブパスは許可しない。規則4では、DB接続モジュールとしては扱わず、
 * その中の `pg` の参照で判定する（`pg` を factory 付きの vi.mock で置き換えたテストだけが、DBに到達しない）。
 */
const ALLOWED_PG_DRIVER_FILES = new Set(["lib/testing/testDbConnection.ts"]);
const LEGACY_GENERATED_DIR = "lib/generated/prisma";
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** ルート直下だけで除外するディレクトリ（ビルド生成物など） */
const EXCLUDED_ROOT_DIRS = new Set([".git", ".next", "out", "build"]);

type Rule =
  | "prisma-client-constructor"
  | "prisma-adapter-pg"
  | "pg-driver"
  | "legacy-generated-prisma"
  | "db-module-reexport";

type Violation = { file: string; line: number; rule: Rule; detail: string };

const isPrismaClientModule = (spec: string) => /^(@prisma\/client|\.prisma\/client)(\/|$)/.test(spec);
const isPrismaAdapterPg = (spec: string) => /^@prisma\/adapter-pg(\/|$)/.test(spec);
const isPgDriver = (spec: string) => /^(pg|pg-pool|pg-native)(\/|$)/.test(spec);

/** `@/` と相対パスを、リポジトリ相対のパスに直す。パッケージ名なら undefined */
function resolveLocal(fromFile: string, spec: string): string | undefined {
  if (spec.startsWith("@/")) return path.posix.normalize(spec.slice(2));
  if (spec.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return undefined;
}

function isLegacyGenerated(fromFile: string, spec: string): boolean {
  const resolved = resolveLocal(fromFile, spec);
  if (resolved === LEGACY_GENERATED_DIR || resolved?.startsWith(`${LEGACY_GENERATED_DIR}/`)) return true;
  return /(^|\/)generated\/prisma(\/|$)/.test(spec);
}

function isAppPrismaModule(fromFile: string, spec: string): boolean {
  return resolveLocal(fromFile, spec)?.replace(/\.(ts|js)$/, "") === "lib/prisma";
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAwaitExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

/** require("x")・import("x")・module.require("x")・vi.importActual("x") などなら、そのモジュール名を返す */
function loadedModule(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const [arg] = node.arguments;
  if (!arg || !ts.isStringLiteralLike(arg)) return undefined;
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return arg.text;
  if (ts.isIdentifier(callee) && callee.text === "require") return arg.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ["require", "importActual", "importMock", "requireActual"].includes(callee.name.text)
  ) {
    return arg.text;
  }
  return undefined;
}

/** 型の位置にあるか（クラスの extends は値として扱う） */
function isTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current)) {
      const clause = current.parent;
      return !(ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(clause.parent));
    }
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

/** 束縛を参照している位置の識別子か（宣言名・プロパティ名などを除く） */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isImportEqualsDeclaration(parent)) return false;
  if (ts.isExportSpecifier(parent)) {
    const declaration = parent.parent.parent;
    if (declaration.moduleSpecifier || declaration.isTypeOnly || parent.isTypeOnly) return false;
    return id === (parent.propertyName ?? parent.name);
  }
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id;
  if (ts.isQualifiedName(parent)) return parent.left === id;
  if (ts.isBindingElement(parent)) return parent.initializer === id;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ("name" in parent && parent.name === id) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

function findDbConnectionViolations(file: string, source: string): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const allowed = ALLOWED_CONNECTION_FILES.has(file);
  const violations: Violation[] = [];
  const report = (node: ts.Node, rule: Rule, detail: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ file, line: line + 1, rule, detail });
  };

  // 1回目：PrismaClient のコンストラクタと、@prisma/client の名前空間・@/lib/prisma から import した束縛を集める
  const constructorNames = new Set<string>();
  const namespaceNames = new Set<string>();
  const appPrismaNames = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause && isPrismaClientModule(spec)) {
        if (clause.name) namespaceNames.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaceNames.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "PrismaClient") {
              constructorNames.add(element.name.text);
            }
          }
        }
      }
      if (clause && isAppPrismaModule(file, spec)) {
        if (clause.name) appPrismaNames.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) appPrismaNames.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (!element.isTypeOnly) appPrismaNames.add(element.name.text);
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      isPrismaClientModule(node.moduleReference.expression.text)
    ) {
      namespaceNames.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const spec = loadedModule(unwrap(node.initializer));
      if (spec && isPrismaClientModule(spec)) {
        if (ts.isIdentifier(node.name)) namespaceNames.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const key = element.propertyName ?? element.name;
            const keyText = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
            if (keyText === "PrismaClient" && ts.isIdentifier(element.name)) constructorNames.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  /** 式が @prisma/client のモジュール（名前空間の束縛、または require・import の結果）か */
  const isPrismaClientNamespace = (expr: ts.Expression): boolean => {
    const target = unwrap(expr);
    if (ts.isIdentifier(target)) return namespaceNames.has(target.text);
    const spec = loadedModule(target);
    return spec !== undefined && isPrismaClientModule(spec);
  };

  const checkModuleReference = (node: ts.Node, spec: string) => {
    if (isLegacyGenerated(file, spec)) report(node, "legacy-generated-prisma", `references "${spec}"`);
    if (allowed) return;
    if (isPrismaAdapterPg(spec)) report(node, "prisma-adapter-pg", `references "${spec}"`);
    if (isPgDriver(spec) && !(ALLOWED_PG_DRIVER_FILES.has(file) && spec === "pg")) report(node, "pg-driver", `references "${spec}"`);
  };

  // 2回目：違反を探す
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) checkModuleReference(node, node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      checkModuleReference(node, node.moduleReference.expression.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      checkModuleReference(node, node.argument.literal.text);
    }
    const loaded = loadedModule(node);
    if (loaded !== undefined) checkModuleReference(node, loaded);

    // 再export
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (isAppPrismaModule(file, spec)) report(node, "db-module-reexport", `re-exports "${spec}"`);
      if (isPrismaClientModule(spec)) {
        const clause = node.exportClause;
        const exportsConstructor =
          !node.isTypeOnly &&
          (!clause ||
            ts.isNamespaceExport(clause) ||
            clause.elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === "PrismaClient"));
        if (exportsConstructor) report(node, "db-module-reexport", `re-exports PrismaClient from "${spec}"`);
      }
    }
    if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier && !node.isTypeOnly) {
      const local = (node.propertyName ?? node.name).text;
      if (appPrismaNames.has(local)) report(node, "db-module-reexport", `re-exports "${local}" from lib/prisma`);
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression) && appPrismaNames.has(node.expression.text)) {
      report(node, "db-module-reexport", `re-exports "${node.expression.text}" from lib/prisma`);
    }

    // PrismaClient のコンストラクタの値としての参照
    if (!allowed && !isTypePosition(node)) {
      if (ts.isIdentifier(node) && isReference(node)) {
        if (constructorNames.has(node.text)) {
          report(node, "prisma-client-constructor", `uses PrismaClient (as "${node.text}") as a value`);
        }
        const parent = node.parent;
        const accessed =
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
        if (namespaceNames.has(node.text) && !accessed) {
          report(node, "prisma-client-constructor", `uses the @prisma/client module "${node.text}" as a value`);
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "PrismaClient" &&
        isPrismaClientNamespace(node.expression)
      ) {
        report(node, "prisma-client-constructor", "uses PrismaClient through the module object");
      }
      if (ts.isElementAccessExpression(node) && isPrismaClientNamespace(node.expression)) {
        const key = node.argumentExpression;
        if (!ts.isStringLiteralLike(key)) {
          report(node, "prisma-client-constructor", "accesses the @prisma/client module with a computed key");
        } else if (key.text === "PrismaClient") {
          report(node, "prisma-client-constructor", "uses PrismaClient through the module object");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function listSourceFiles(dir = ""): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = dir ? path.posix.join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || (dir === "" && EXCLUDED_ROOT_DIRS.has(entry.name))) return [];
      if (relative === LEGACY_GENERATED_DIR) return [];
      return listSourceFiles(relative);
    }
    return entry.isFile() && SOURCE_FILE.test(entry.name) ? [relative] : [];
  });
}

const rulesOf = (file: string, source: string) =>
  [...new Set(findDbConnectionViolations(file, source).map((v) => v.rule))].sort();

// ---- 規則3・規則4 ----

/**
 * 実DBに依存する既知のテスト（静的監査用）。Vitest の除外設定とは別に持ち、除外は命名規則（INTEGRATION_TEST_GLOB）だけで行う。
 */
const KNOWN_DB_INTEGRATION_TEST_FILES = [
  "lib/dashboard/marketFilterMasters.integration.test.ts",
  "lib/dashboard/recentImports.integration.test.ts",
  "lib/dashboard/trendPeriod.integration.test.ts",
  "lib/market-analytics/currentMetrics.integration.test.ts",
  "lib/market-analytics/priceTrend.integration.test.ts",
  "lib/market-analytics/soldMetrics.integration.test.ts",
];
// Step 3-12B-5A で lib/testing/migrationChecksum.test.ts を追加（33 → 34）
// Step 3-12B-5B で lib/testing/schemaDiff.test.ts を追加（34 → 35）
// Step 3-12B-5C-1 で lib/testing/testDbChecksums.test.ts を追加（35 → 36）
// Step 3-12B-5C-5B で lib/testing/testDbCatalogAudit.test.ts を追加（36 → 37）
// Step 3-12B-5C-5C で lib/testing/testDbCatalogRunner.test.ts を追加（37 → 38）
// Step 3-12B-5E-3 で lib/testing/testDbReadOnlyRole.test.ts・testDbReadOnlyRoleRunner.test.ts を追加（38 → 40）
// Step 3-12B-5E-9A-9-2 で lib/testing/testDbSchemaDiffRunner.test.ts を追加（40 → 41）
// Step 4-3 で lib/testing/integrationDatabaseSetup.test.ts を追加（41 → 42）
// Step 4-4 で lib/testing/integrationWorkerCheck.test.ts を追加（42 → 43）
// Step 4-13B で lib/testing/e2eDevServer.test.ts を追加（43 → 44）
const EXPECTED_UNIT_TEST_COUNT = 44;
const INTEGRATION_TEST_GLOB = "**/*.integration.test.{ts,tsx}";
const TEST_FILE = /\.test\.tsx?$/;
const INTEGRATION_TEST_FILE = /\.integration\.test\.tsx?$/;
/** Vitest の既定の include に当てはまり得るファイル名 */
const TEST_LIKE_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** 依存関係の解析が読むファイル。リポジトリとインメモリの両方で使う */
type ModuleHost = { isFile(file: string): boolean; read(file: string): string };

const repoHost: ModuleHost = {
  // 大文字・小文字を区別しないファイルシステムでも、名前が完全に一致するファイルだけを認める
  isFile(file) {
    if (file.startsWith("..") || path.isAbsolute(file)) return false;
    try {
      const dir = path.join(ROOT, path.posix.dirname(file));
      return readdirSync(dir).includes(path.posix.basename(file)) && statSync(path.join(ROOT, file)).isFile();
    } catch {
      return false;
    }
  },
  read: (file) => readFileSync(path.join(ROOT, file), "utf8"),
};

type Resolved = { kind: "local"; file: string } | { kind: "package"; name: string } | { kind: "unresolved" };

function resolveModule(host: ModuleHost, fromFile: string, spec: string): Resolved {
  const base = resolveLocal(fromFile, spec);
  if (base === undefined) return { kind: "package", name: spec };
  if (base.startsWith("..")) return { kind: "unresolved" };
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => stem + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  const file = candidates.find((candidate) => host.isFile(candidate));
  return file ? { kind: "local", file } : { kind: "unresolved" };
}

type LoadVia = "import" | "require" | "dynamic-import" | "importActual" | "importMock";
type ModuleLoad = { spec: string; via: LoadVia; line: number };
type MockFactory = "none" | "inline" | "inline-with-params" | "other";
type MockCall = { method: "mock" | "doMock" | "unmock" | "doUnmock"; spec: string | undefined; factory: MockFactory; line: number };
type ModuleScan = { loads: ModuleLoad[]; mocks: MockCall[]; unverified: string[] };

const MOCK_METHODS = new Set(["mock", "doMock", "unmock", "doUnmock"]);

/** 1つのモジュールが実行時に読み込むモジュールと、vi.mock などの呼び出しを集める（型だけの import は除く） */
function scanModule(file: string, source: string): ModuleScan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const literal = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
  const scan: ModuleScan = { loads: [], mocks: [], unverified: [] };
  const unverified = (node: ts.Node, detail: string) => scan.unverified.push(`${file}:${lineOf(node)} ${detail}`);

  // `import { vi as v } from "vitest"` のような別名も vi として扱う
  const viNames = new Set(["vi"]);
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || literal(statement.moduleSpecifier) !== "vitest") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (["vi", "vitest"].includes((element.propertyName ?? element.name).text)) viNames.add(element.name.text);
      }
    }
  }
  const viMethod = (call: ts.CallExpression) => {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && viNames.has(callee.expression.text)
      ? callee.name.text
      : undefined;
  };

  /** `vi.mock(import("…"))` の import() はモジュールを読み込まない（Vitest がパスに書き換える） */
  const mockPathImports = new Set<ts.Node>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== undefined) scan.loads.push({ spec, via: "import", line: lineOf(node) });
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== undefined) scan.loads.push({ spec, via: "import", line: lineOf(node) });
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== undefined) scan.loads.push({ spec, via: "require", line: lineOf(node) });
      else unverified(node, "import = require() with a non-literal specifier");
    }
    if (ts.isCallExpression(node) && !mockPathImports.has(node)) {
      const callee = node.expression;
      const [arg] = node.arguments;
      const method = viMethod(node);
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        const spec = literal(arg);
        const via = callee.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require";
        if (spec !== undefined) scan.loads.push({ spec, via, line: lineOf(node) });
        else unverified(node, `${via} with a non-literal specifier`);
      } else if (ts.isIdentifier(callee) && (callee.text === "eval" || callee.text === "createRequire")) {
        unverified(node, `${callee.text}() cannot be analyzed`);
      } else if (method === "importActual" || method === "importMock") {
        const spec = literal(arg);
        if (spec !== undefined) scan.loads.push({ spec, via: method, line: lineOf(node) });
        else unverified(node, `vi.${method} with a non-literal specifier`);
      } else if (method !== undefined && MOCK_METHODS.has(method)) {
        let spec = literal(arg);
        if (arg && ts.isCallExpression(arg) && arg.expression.kind === ts.SyntaxKind.ImportKeyword) {
          mockPathImports.add(arg);
          spec = literal(arg.arguments[0]);
        }
        if (spec === undefined) unverified(node, `vi.${method} with a non-literal path`);
        const factoryArg = node.arguments[1];
        const factory: MockFactory = !factoryArg
          ? "none"
          : ts.isArrowFunction(factoryArg) || ts.isFunctionExpression(factoryArg)
            ? factoryArg.parameters.length > 0
              ? "inline-with-params"
              : "inline"
            : "other";
        scan.mocks.push({ method: method as MockCall["method"], spec, factory, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return scan;
}

type PrismaMockRule =
  | "prisma-mock-without-factory"
  | "prisma-import-original"
  | "prisma-mock-unverifiable-factory"
  | "prisma-import-actual"
  | "prisma-unmock";

type PrismaMockViolation = { file: string; line: number; rule: PrismaMockRule };

/** 規則3：通常テストが、モックをすり抜けて本物の lib/prisma.ts を評価する書き方をしていないか */
function findPrismaMockViolations(file: string, source: string): PrismaMockViolation[] {
  if (INTEGRATION_TEST_FILE.test(file)) return [];
  const scan = scanModule(file, source);
  const violations: PrismaMockViolation[] = [];
  for (const mock of scan.mocks) {
    if (mock.spec === undefined || !isAppPrismaModule(file, mock.spec)) continue;
    const rule: PrismaMockRule | undefined =
      mock.method === "unmock" || mock.method === "doUnmock"
        ? "prisma-unmock"
        : mock.factory === "none"
          ? "prisma-mock-without-factory"
          : mock.factory === "inline-with-params"
            ? "prisma-import-original"
            : mock.factory === "other"
              ? "prisma-mock-unverifiable-factory"
              : undefined;
    if (rule) violations.push({ file, line: mock.line, rule });
  }
  for (const load of scan.loads) {
    if (load.via === "importActual" && isAppPrismaModule(file, load.spec)) {
      violations.push({ file, line: load.line, rule: "prisma-import-actual" });
    }
  }
  return violations;
}

const prismaMockRulesOf = (file: string, source: string) =>
  [...new Set(findPrismaMockViolations(file, source).map((v) => v.rule))].sort();

type DbDependency = {
  /** DB接続モジュールまでの経路（到達しなければ undefined） */
  dbPath: string[] | undefined;
  /** 静的に判定できなかった箇所 */
  unverified: string[];
};

/** 規則4：テストファイルから import 依存関係を辿り、モックされていないDB接続モジュールに到達するか */
function analyzeDbDependency(host: ModuleHost, testFile: string, options: { honorMocks?: boolean } = {}): DbDependency {
  const { honorMocks = true } = options;
  const unverified: string[] = [];
  const entry = scanModule(testFile, host.read(testFile));
  unverified.push(...entry.unverified);

  // テストファイルの vi.mock は hoist され、依存先のどこから読み込まれても有効になる
  const mocked = new Set<string>();
  const unmocked = new Set<string>();
  for (const mock of entry.mocks) {
    if (mock.spec === undefined) continue;
    const resolved = resolveModule(host, testFile, mock.spec);
    if (resolved.kind === "unresolved") {
      unverified.push(`${testFile}:${mock.line} cannot resolve vi.${mock.method}("${mock.spec}")`);
      continue;
    }
    const key = resolved.kind === "local" ? resolved.file : resolved.name;
    if (mock.method === "unmock" || mock.method === "doUnmock") unmocked.add(key);
    // 自動モック・importOriginal を受け取る factory・順序に依存する vi.doMock は、本物を読み込むものとして辿る
    else if (mock.method === "mock" && mock.factory === "inline") mocked.add(key);
  }
  for (const key of unmocked) mocked.delete(key);
  if (!honorMocks) mocked.clear();

  const isDbModule = (file: string) =>
    ALLOWED_CONNECTION_FILES.has(file) || file === LEGACY_GENERATED_DIR || file.startsWith(`${LEGACY_GENERATED_DIR}/`);
  const visited = new Set<string>([testFile]);
  const queue: { file: string; chain: string[]; scan: ModuleScan }[] = [{ file: testFile, chain: [testFile], scan: entry }];
  while (queue.length > 0) {
    const { file, chain, scan } = queue.shift()!;
    for (const load of scan.loads) {
      const resolved = resolveModule(host, file, load.spec);
      if (resolved.kind === "unresolved") {
        unverified.push(`${file}:${load.line} cannot resolve "${load.spec}"`);
        continue;
      }
      const target = resolved.kind === "local" ? resolved.file : resolved.name;
      // vi.importActual はそのモジュール自身だけ本物を読み込む。その先の import には、モックが効いたまま
      if (load.via !== "importActual" && mocked.has(target)) continue;
      // パッケージの中は辿らない（ローカルのファイルを読み込むパッケージは検出できない）
      if (resolved.kind === "package") {
        if (isPgDriver(target) || isPrismaAdapterPg(target)) return { dbPath: [...chain, target], unverified };
        continue;
      }
      if (isDbModule(target)) return { dbPath: [...chain, target], unverified };
      if (visited.has(target) || !SOURCE_FILE.test(target)) continue;
      visited.add(target);
      const targetScan = scanModule(target, host.read(target));
      unverified.push(...targetScan.unverified);
      if (targetScan.mocks.length > 0) unverified.push(`${target}: vi.mock-like calls outside the test file`);
      queue.push({ file: target, chain: [...chain, target], scan: targetScan });
    }
  }
  return { dbPath: undefined, unverified };
}

type TestClassification = {
  unitTests: string[];
  integrationTests: string[];
  violations: string[];
  /** 通常テストのうち、静的に判定できなかった箇所 */
  unverified: string[];
};

/** 規則4：命名による分類と、依存関係の解析結果が一致しているか */
function auditTestClassification(host: ModuleHost, testFiles: string[], knownDbTestFiles: string[]): TestClassification {
  const result: TestClassification = { unitTests: [], integrationTests: [], violations: [], unverified: [] };
  for (const file of testFiles) {
    const integration = INTEGRATION_TEST_FILE.test(file);
    (integration ? result.integrationTests : result.unitTests).push(file);
    const { dbPath, unverified } = analyzeDbDependency(host, file);
    if (!integration && dbPath) result.violations.push(`${file}: unit test reaches the real DB (${dbPath.join(" -> ")})`);
    if (integration && !dbPath) result.violations.push(`${file}: named as an integration test but does not reach the DB`);
    if (!integration && !dbPath) result.unverified.push(...unverified);
  }
  for (const known of knownDbTestFiles) {
    if (!INTEGRATION_TEST_FILE.test(known)) result.violations.push(`${known}: known DB test is not named *.integration.test.*`);
    else if (!testFiles.includes(known)) result.violations.push(`${known}: known DB test is missing (renamed or deleted)`);
  }
  return result;
}

/** vitest.config.ts の test 設定が、命名規則だけで統合テストを除外しているか */
function vitestConfigIssues(source: string): string[] {
  const sf = ts.createSourceFile("vitest.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const issues: string[] = [];
  const propertyName = (name: ts.PropertyName) => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined);
  const testConfigs: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "DB_INTEGRATION_TEST_FILES") {
      issues.push("DB_INTEGRATION_TEST_FILES must not be used; exclude integration tests by name only");
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "test" && ts.isObjectLiteralExpression(node.initializer)) {
      testConfigs.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (testConfigs.length !== 1) return [...issues, `expected exactly one test config, found ${testConfigs.length}`];

  const properties = new Map<string, ts.Expression>();
  for (const property of testConfigs[0].properties) {
    const name = ts.isPropertyAssignment(property) ? propertyName(property.name) : undefined;
    if (name === undefined || !ts.isPropertyAssignment(property)) issues.push("test config has a property that cannot be analyzed");
    else properties.set(name, property.initializer);
  }
  const arrayEntries = (expr: ts.Expression | undefined) =>
    expr && ts.isArrayLiteralExpression(expr)
      ? expr.elements.map((element) => {
          if (ts.isStringLiteralLike(element)) return element.text;
          if (ts.isSpreadElement(element) && element.expression.getText(sf) === "configDefaults.exclude") {
            return "...configDefaults.exclude";
          }
          return "<unanalyzable>";
        })
      : undefined;
  const exclude = arrayEntries(properties.get("exclude"));
  if (JSON.stringify(exclude) !== JSON.stringify(["...configDefaults.exclude", INTEGRATION_TEST_GLOB])) {
    issues.push(`test.exclude must be [...configDefaults.exclude, "${INTEGRATION_TEST_GLOB}"], got ${JSON.stringify(exclude)}`);
  }
  if (properties.has("include")) {
    const include = arrayEntries(properties.get("include"));
    if (JSON.stringify(include) !== JSON.stringify(["**/*.test.{ts,tsx}"])) {
      issues.push(`test.include must be absent or ["**/*.test.{ts,tsx}"], got ${JSON.stringify(include)}`);
    }
  }
  // 依存関係の解析は、テストファイルから辿る経路だけを見ている
  for (const key of ["setupFiles", "globalSetup", "projects", "workspace"]) {
    if (properties.has(key)) issues.push(`test.${key} is not covered by the dependency analysis`);
  }
  return issues;
}

describe("DB接続経路（リポジトリの走査）", () => {
  const files = listSourceFiles();

  it("走査対象のソースが存在し、除外対象が含まれない（走査漏れの検出）", () => {
    for (const expected of [
      "lib/prisma.ts",
      "prisma/seed.ts",
      "prisma/seeds/index.ts",
      "prisma.config.ts",
      "proxy.ts",
      "eslint.config.mjs",
      "app/[locale]/dashboard/page.tsx",
      "lib/testing/dbConnectionPaths.test.ts",
    ]) {
      expect(files).toContain(expected);
    }
    const excluded = files.filter((f) => /(^|\/)node_modules\//.test(f) || /^(\.git|\.next|out|build)\//.test(f));
    expect(excluded).toEqual([]);
    expect(files.filter((f) => f.startsWith(`${LEGACY_GENERATED_DIR}/`))).toEqual([]);
  });

  it("許可リストのファイルが実在する", () => {
    for (const allowedFile of ALLOWED_CONNECTION_FILES) expect(files).toContain(allowedFile);
  });

  it("許可リストの外に、DB接続の生成・直接利用・古い生成コードの参照・再exportがない", () => {
    const violations = files.flatMap((file) =>
      findDbConnectionViolations(file, readFileSync(path.join(ROOT, file), "utf8")).map(
        (v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("pg だけの許可リストのファイルが実在し、その中身は別のパスに置くと pg-driver として検出される", () => {
    for (const file of ALLOWED_PG_DRIVER_FILES) {
      expect(files).toContain(file);
      expect(rulesOf(file, readFileSync(path.join(ROOT, file), "utf8"))).toEqual([]);
      expect(rulesOf("lib/elsewhere.ts", readFileSync(path.join(ROOT, file), "utf8"))).toEqual(["pg-driver"]);
    }
  });

  it.each([...ALLOWED_CONNECTION_FILES])("%s の中身は、別のパスに置くと検出される（検査の空振りの検出）", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    expect(rulesOf("lib/elsewhere.ts", source)).toEqual(["prisma-adapter-pg", "prisma-client-constructor"]);
  });
});

describe("DB接続経路の検査器（インメモリのソース）", () => {
  const connection = [
    'import { PrismaClient } from "@prisma/client";',
    'import { PrismaPg } from "@prisma/adapter-pg";',
    "const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });",
    "export const prisma = new PrismaClient({ adapter });",
  ].join("\n");

  it.each(["lib/prisma.ts", "prisma/seed.ts"])("許可された %s での生成は成功する", (file) => {
    expect(findDbConnectionViolations(file, connection)).toEqual([]);
  });

  it.each(["lib/db/prisma.ts", "app/prisma.ts", "scripts/seed.ts", "lib/seed.ts", "./lib/prisma.ts"])(
    "ファイル名が同じでもパスが違う %s は許可しない",
    (file) => {
      expect(rulesOf(file, connection)).toEqual(["prisma-adapter-pg", "prisma-client-constructor"]);
    },
  );

  it.each<[string, string, Rule]>([
    // PrismaClient
    ["named import", 'import { PrismaClient } from "@prisma/client";\nnew PrismaClient();', "prisma-client-constructor"],
    ["別名import", 'import { PrismaClient as Db } from "@prisma/client";\nconst db = new Db();', "prisma-client-constructor"],
    ["namespace import", 'import * as P from "@prisma/client";\nnew P.PrismaClient();', "prisma-client-constructor"],
    ["default import と要素アクセス", 'import P from "@prisma/client";\nnew P["PrismaClient"]();', "prisma-client-constructor"],
    ["import = require", 'import P = require("@prisma/client");\nnew P.PrismaClient();', "prisma-client-constructor"],
    ["require と分割代入", 'const { PrismaClient: C } = require("@prisma/client");\nnew C();', "prisma-client-constructor"],
    ["動的import と分割代入", 'const { PrismaClient } = await import("@prisma/client");\nnew PrismaClient();', "prisma-client-constructor"],
    ["require の結果を直接", 'new (require("@prisma/client").PrismaClient)();', "prisma-client-constructor"],
    ["動的import の結果を直接", 'new (await import("@prisma/client")).PrismaClient();', "prisma-client-constructor"],
    ["サブパス", 'import { PrismaClient } from "@prisma/client/default";\nnew PrismaClient();', "prisma-client-constructor"],
    ["改行をはさんだ new", 'import {\n  PrismaClient,\n} from "@prisma/client";\nconst p = new\n  PrismaClient\n  ({});', "prisma-client-constructor"],
    ["変数への代入", 'import { PrismaClient } from "@prisma/client";\nconst A = PrismaClient;\nnew A();', "prisma-client-constructor"],
    ["継承", 'import { PrismaClient } from "@prisma/client";\nclass Db extends PrismaClient {}', "prisma-client-constructor"],
    ["Reflect.construct", 'import { PrismaClient } from "@prisma/client";\nReflect.construct(PrismaClient, []);', "prisma-client-constructor"],
    ["名前空間の受け渡し", 'const P = await import("@prisma/client");\nconst { PrismaClient } = P;', "prisma-client-constructor"],
    ["計算されたキー", 'import * as P from "@prisma/client";\nconst k = "Prisma" + "Client";\nnew P[k]();', "prisma-client-constructor"],
    // PrismaPg
    ["PrismaPg", 'import { PrismaPg } from "@prisma/adapter-pg";\nnew PrismaPg({});', "prisma-adapter-pg"],
    ["PrismaPg の別名import", 'import { PrismaPg as A } from "@prisma/adapter-pg";\nnew A({});', "prisma-adapter-pg"],
    ["PrismaPg の namespace import", 'import * as A from "@prisma/adapter-pg";\nnew A.PrismaPg({});', "prisma-adapter-pg"],
    ["PrismaPg の require", 'const { PrismaPg } = require("@prisma/adapter-pg");', "prisma-adapter-pg"],
    // pg
    ["pg の named import", 'import { Pool } from "pg";\nnew Pool();', "pg-driver"],
    ["pg の default import", 'import pg from "pg";\nnew pg.Client();', "pg-driver"],
    ["pg の副作用import", 'import "pg";', "pg-driver"],
    ["pg の型import", 'import type { Pool } from "pg";', "pg-driver"],
    ["pg の require", 'const { Client } = require("pg");', "pg-driver"],
    ["pg の動的import", 'const pg = await import("pg");', "pg-driver"],
    ["pg のテンプレート文字列の動的import", "const pg = await import(`pg`);", "pg-driver"],
    ["pg の import = require", 'import pg = require("pg");', "pg-driver"],
    ["pg のサブパス", 'import Client from "pg/lib/client";', "pg-driver"],
    ["pg-pool", 'import Pool from "pg-pool";', "pg-driver"],
    ["pg の再export", 'export * from "pg";', "pg-driver"],
    ["pg の vi.importActual", 'await vi.importActual("pg");', "pg-driver"],
    // 古い生成コード
    ["generated の相対import", 'import { PrismaClient } from "../generated/prisma/client";', "legacy-generated-prisma"],
    ["generated の @ import", 'import type { Product } from "@/lib/generated/prisma/models";', "legacy-generated-prisma"],
    ["generated の require", 'require("../generated/prisma");', "legacy-generated-prisma"],
    ["generated の動的import", 'await import("@/lib/generated/prisma/client");', "legacy-generated-prisma"],
    ["generated の再export", 'export * from "../generated/prisma/enums";', "legacy-generated-prisma"],
    ["generated の import 型", 'type C = import("../generated/prisma/client").PrismaClient;', "legacy-generated-prisma"],
    // 再export
    ["lib/prisma の再export", 'export { prisma } from "@/lib/prisma";', "db-module-reexport"],
    ["lib/prisma の相対パスでの再export", 'export * from "../prisma";', "db-module-reexport"],
    ["lib/prisma の値の再export", 'import { prisma } from "@/lib/prisma";\nexport { prisma as db };', "db-module-reexport"],
    ["lib/prisma の値の default export", 'import { prisma } from "@/lib/prisma";\nexport default prisma;', "db-module-reexport"],
    ["PrismaClient の再export", 'export { PrismaClient as Db } from "@prisma/client";', "db-module-reexport"],
    ["@prisma/client 全体の再export", 'export * from "@prisma/client";', "db-module-reexport"],
    ["PrismaClient のローカルな再export", 'import { PrismaClient } from "@prisma/client";\nexport { PrismaClient };', "prisma-client-constructor"],
  ])("%s を検出する", (_name, source, rule) => {
    expect(rulesOf("lib/dashboard/example.ts", source)).toContain(rule);
  });

  it("許可リストのファイルでも、古い生成コードの参照は検出する", () => {
    const source = 'import { PrismaClient } from "./generated/prisma/client";\nnew PrismaClient();';
    expect(rulesOf("lib/prisma.ts", source)).toEqual(["legacy-generated-prisma"]);
  });

  it("許可リストのファイルでは pg の利用を許可する", () => {
    expect(rulesOf("prisma/seed.ts", 'import { Pool } from "pg";\nnew Pool();')).toEqual([]);
  });

  it("pg だけの許可リストのファイルでは、pg（完全一致）の import だけを許可する", () => {
    const file = [...ALLOWED_PG_DRIVER_FILES][0];
    expect(rulesOf(file, 'import pg from "pg";\nnew pg.Client({});')).toEqual([]);
    expect(rulesOf(file, 'const { Client } = await import("pg");')).toEqual([]);
    for (const spec of ["pg/lib/client", "pg-pool", "pg-native"]) {
      expect(rulesOf(file, `import x from "${spec}";`)).toEqual(["pg-driver"]);
    }
    expect(rulesOf(file, 'import { PrismaPg } from "@prisma/adapter-pg";')).toEqual(["prisma-adapter-pg"]);
    expect(rulesOf(file, 'import { PrismaClient } from "@prisma/client";\nnew PrismaClient();')).toEqual(["prisma-client-constructor"]);
  });

  it("pg だけの許可は、パスが完全一致するファイルに限る", () => {
    for (const file of ["lib/testing/testDbConnection.mts", "lib/testDbConnection.ts", "scripts/testDbConnection.ts", "lib/testing/testDbState.ts"]) {
      expect(rulesOf(file, 'import pg from "pg";')).toEqual(["pg-driver"]);
    }
  });

  it("コメントや文字列の中の記述は検出しない", () => {
    const source = [
      "// new PrismaClient()",
      '/* import { Pool } from "pg"; const p = new PrismaPg({}); */',
      "/** @example require(\"@/lib/generated/prisma\") */",
      "const a = 'new PrismaClient()';",
      'const b = "import { PrismaPg } from \\"@prisma/adapter-pg\\"";',
      'const c = `require("pg")`;',
    ].join("\n");
    expect(findDbConnectionViolations("lib/dashboard/example.ts", source)).toEqual([]);
  });

  it("通常の Prisma の型・enum・Prisma 名前空間の利用は検出しない", () => {
    const source = [
      'import type { ImportRow, PrismaClient as Client } from "@prisma/client";',
      'import { Prisma, PrismaClient, ProductStatus, UserRole } from "@prisma/client";',
      'import { type PrismaClient as Typed } from "@prisma/client";',
      "export async function seedMaster(db: PrismaClient, other: Client, typed: Typed): Promise<Prisma.Sql> {",
      "  const status = ProductStatus.ACTIVE;",
      "  if (UserRole.ADMIN) return Prisma.sql`SELECT 1`;",
      "  return Prisma.sql`SELECT ${status}`;",
      "}",
      "type Ctor = typeof PrismaClient;",
      "type Instance = InstanceType<typeof PrismaClient>;",
      'type Tx = Parameters<PrismaClient["$transaction"]>;',
      "interface Db extends PrismaClient {}",
      'class Fake implements Pick<PrismaClient, "$connect"> {}',
      "const rows: ImportRow[] = [];",
      "const db = {} as unknown as PrismaClient;",
      "export type { PrismaClient };",
      'export { Prisma, ProductStatus } from "@prisma/client";',
      'export type { PrismaClient as Db2 } from "@prisma/client";',
      "try {} catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError) throw e; }",
    ].join("\n");
    expect(findDbConnectionViolations("lib/dashboard/example.ts", source)).toEqual([]);
  });

  it("lib/prisma の通常の利用と、無関係の同名クラスは検出しない", () => {
    const source = [
      'import { prisma } from "@/lib/prisma";',
      'import { Pool, Client } from "./workers";',
      'import { PrismaClient } from "./fakes";',
      "new Pool();",
      "new Client();",
      "new PrismaClient();",
      "export async function list() { return prisma.product.findMany(); }",
    ].join("\n");
    expect(findDbConnectionViolations("lib/dashboard/example.ts", source)).toEqual([]);
  });

  it("違反の行番号を返す", () => {
    const source = 'import { PrismaClient } from "@prisma/client";\n\nconst p = new PrismaClient();';
    expect(findDbConnectionViolations("lib/dashboard/example.ts", source)).toEqual([
      {
        file: "lib/dashboard/example.ts",
        line: 3,
        rule: "prisma-client-constructor",
        detail: 'uses PrismaClient (as "PrismaClient") as a value',
      },
    ]);
  });
});

describe("テストからの本物のPrisma・テストの分類（リポジトリの走査）", () => {
  const files = listSourceFiles();
  const testFiles = files.filter((file) => TEST_FILE.test(file));
  const unitTests = testFiles.filter((file) => !INTEGRATION_TEST_FILE.test(file));
  const prismaMockingUnitTests = unitTests.filter((file) =>
    scanModule(file, repoHost.read(file)).mocks.some(
      (mock) => mock.method === "mock" && mock.spec !== undefined && isAppPrismaModule(file, mock.spec),
    ),
  );

  it("規則3：通常テストに、本物の lib/prisma.ts を評価する Prisma モックの書き方がない", () => {
    const violations = unitTests.flatMap((file) =>
      findPrismaMockViolations(file, repoHost.read(file)).map((v) => `${v.file}:${v.line} [${v.rule}]`),
    );
    expect(violations).toEqual([]);
  });

  it("規則4：通常テスト25件・統合テスト6件で、統合テストは既知の6ファイルと一致する", () => {
    const audit = auditTestClassification(repoHost, testFiles, KNOWN_DB_INTEGRATION_TEST_FILES);
    expect(audit.unitTests).toHaveLength(EXPECTED_UNIT_TEST_COUNT);
    expect([...audit.integrationTests].sort()).toEqual([...KNOWN_DB_INTEGRATION_TEST_FILES].sort());
  });

  it("規則4：通常テストはDBに到達せず、統合テストはすべてDBに到達する（依存関係の解析）", () => {
    expect(auditTestClassification(repoHost, testFiles, KNOWN_DB_INTEGRATION_TEST_FILES).violations).toEqual([]);
  });

  it("規則4：通常テストの依存関係に、静的に判定できない箇所がない（未確認0件）", () => {
    expect(auditTestClassification(repoHost, testFiles, KNOWN_DB_INTEGRATION_TEST_FILES).unverified).toEqual([]);
  });

  it.each(KNOWN_DB_INTEGRATION_TEST_FILES)("規則4：既知の %s は、名前でも依存関係でも統合テストに分類される", (file) => {
    expect(file).toMatch(INTEGRATION_TEST_FILE);
    expect(testFiles).toContain(file);
    expect(analyzeDbDependency(repoHost, file).dbPath).toBeDefined();
  });

  it("規則4：pg だけの許可リストのファイルのテストは、pg のモックを無視するとDBに到達する（解析の空振りの検出）", () => {
    const tests = unitTests.filter((file) => [...ALLOWED_PG_DRIVER_FILES].some((allowed) => file === allowed.replace(/\.ts$/, ".test.ts")));
    expect(tests).toHaveLength(ALLOWED_PG_DRIVER_FILES.size);
    for (const file of tests) {
      expect(analyzeDbDependency(repoHost, file).dbPath).toBeUndefined();
      expect(analyzeDbDependency(repoHost, file, { honorMocks: false }).dbPath?.at(-1)).toBe("pg");
    }
  });

  it("規則4：@/lib/prisma をモックしている通常テストは、モックを無視するとDBに到達する（解析の空振りの検出）", () => {
    expect(prismaMockingUnitTests.length).toBeGreaterThan(0);
    const notReached = prismaMockingUnitTests.filter(
      (file) => analyzeDbDependency(repoHost, file, { honorMocks: false }).dbPath === undefined,
    );
    expect(notReached).toEqual([]);
  });

  it("規則4：vitest.config.ts は命名規則だけで統合テストを除外し、DB_INTEGRATION_TEST_FILES を使わない", () => {
    expect(vitestConfigIssues(repoHost.read("vitest.config.ts"))).toEqual([]);
  });

  it("規則4：Vitest の除外パターンと命名規則による分類が、すべてのテストファイルで一致する", () => {
    const mismatched = testFiles.filter(
      (file) => path.posix.matchesGlob(file, INTEGRATION_TEST_GLOB) !== INTEGRATION_TEST_FILE.test(file),
    );
    expect(mismatched).toEqual([]);
    // .spec.* や .test.js などは、命名規則の外で Vitest に拾われ得る
    expect(files.filter((file) => TEST_LIKE_FILE.test(file) && !TEST_FILE.test(file))).toEqual([]);
  });
});

describe("Prisma モックの検査器（規則3・インメモリのソース）", () => {
  const unitFile = "lib/dashboard/example.test.ts";

  it.each([
    ["factory 付きのモック", 'vi.mock("@/lib/prisma", () => ({ prisma: { product: { findMany: vi.fn() } } }));'],
    ["async の factory", 'vi.mock("@/lib/prisma", async () => ({ prisma: {} }));'],
    ["function 式の factory", 'vi.mock("@/lib/prisma", function () { return { prisma: {} }; });'],
    ["import() を渡す形と factory", 'vi.mock(import("@/lib/prisma"), () => ({ prisma: {} }));'],
    ["Prisma 以外への vi.importActual", 'const actual = await vi.importActual("@/lib/auth/context");'],
    [
      "Prisma 以外の importOriginal",
      'vi.mock("@/lib/auth/context", async (importOriginal) => ({ ...(await importOriginal()) }));',
    ],
    ["Prisma 以外の自動モック", 'vi.mock("@/lib/dashboard/dashboardData");'],
    ["コメント・文字列の中の記述", '// vi.mock("@/lib/prisma")\nconst s = \'vi.importActual("@/lib/prisma")\';'],
    ["lib/prisma 以外の同名モジュール", 'vi.mock("@/lib/db/prisma");\nawait vi.importActual("./prisma");'],
  ])("%s は許可する", (_name, source) => {
    expect(findPrismaMockViolations(unitFile, source)).toEqual([]);
  });

  it.each<[string, string, PrismaMockRule]>([
    ["factory なしのモック", 'vi.mock("@/lib/prisma");', "prisma-mock-without-factory"],
    ["import() を渡す形で factory なし", 'vi.mock(import("@/lib/prisma"));', "prisma-mock-without-factory"],
    ["factory なしの vi.doMock", 'vi.doMock("@/lib/prisma");', "prisma-mock-without-factory"],
    [
      "importOriginal を使う factory",
      'vi.mock("@/lib/prisma", async (importOriginal) => ({ ...(await importOriginal()) }));',
      "prisma-import-original",
    ],
    ["引数の名前が違う factory", 'vi.mock("@/lib/prisma", async (orig) => orig());', "prisma-import-original"],
    ["変数の factory", 'const factory = () => ({});\nvi.mock("@/lib/prisma", factory);', "prisma-mock-unverifiable-factory"],
    ["spy オプション", 'vi.mock("@/lib/prisma", { spy: true });', "prisma-mock-unverifiable-factory"],
    ["vi.importActual", 'await vi.importActual("@/lib/prisma");', "prisma-import-actual"],
    ["factory の中の vi.importActual", 'vi.mock("@/lib/prisma", async () => ({ ...(await vi.importActual("@/lib/prisma")) }));', "prisma-import-actual"],
    ["相対パスの vi.importActual", 'await vi.importActual("../prisma");', "prisma-import-actual"],
    ["拡張子付きの vi.importActual", 'await vi.importActual("@/lib/prisma.ts");', "prisma-import-actual"],
    ["相対パスの factory なしモック", 'vi.mock("../prisma");', "prisma-mock-without-factory"],
    ["vi.unmock", 'vi.mock("@/lib/prisma", () => ({}));\nvi.unmock("@/lib/prisma");', "prisma-unmock"],
    ["vi.doUnmock", 'vi.doUnmock("@/lib/prisma");', "prisma-unmock"],
    ["vi の別名", 'import { vi as v } from "vitest";\nv.mock("@/lib/prisma");', "prisma-mock-without-factory"],
  ])("%s を拒否する", (_name, source, rule) => {
    expect(prismaMockRulesOf(unitFile, source)).toEqual([rule]);
  });

  it("違反の行番号を返す", () => {
    expect(findPrismaMockViolations(unitFile, 'import { vi } from "vitest";\n\nvi.mock("@/lib/prisma");')).toEqual([
      { file: unitFile, line: 3, rule: "prisma-mock-without-factory" },
    ]);
  });

  it("統合テストの命名規則のファイルは、規則3の対象外", () => {
    expect(findPrismaMockViolations("lib/dashboard/example.integration.test.ts", 'vi.mock("@/lib/prisma");')).toEqual([]);
  });
});

describe("テストの分類の検査器（規則4・インメモリのソース）", () => {
  const memoryHost = (files: Record<string, string>): ModuleHost => ({
    isFile: (file) => Object.hasOwn(files, file),
    read: (file) => files[file],
  });
  const base: Record<string, string> = {
    "lib/prisma.ts": 'import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();',
    "lib/repo.ts": 'import { prisma } from "./prisma";\nexport const list = () => prisma.product.findMany();',
    "lib/barrel.ts": 'export * from "./repo";',
    "lib/auth.ts": 'import { prisma } from "@/lib/prisma";\nexport const ctx = () => prisma.user.findUnique();',
    "lib/testHelpers.ts": 'import { prisma } from "@/lib/prisma";\nexport const fixture = () => prisma;',
    "lib/pure.ts": 'import data from "./data.json";\nexport const add = (a: number, b: number) => a + b + data.n;',
    "lib/data.json": '{ "n": 0 }',
    "lib/types.ts": 'import type { Prisma } from "@/lib/prisma";\nexport type X = Prisma;',
    "lib/typeElements.ts": 'export type { prisma } from "./prisma";',
    "lib/cycleA.ts": 'import { b } from "./cycleB";\nexport const a = () => b;',
    "lib/cycleB.ts": 'import { a } from "./cycleA";\nexport const b = () => a;',
  };
  const analyze = (source: string, extra: Record<string, string> = {}) =>
    analyzeDbDependency(memoryHost({ ...base, ...extra, "lib/x.test.ts": source }), "lib/x.test.ts");

  it.each([
    ["本物の lib/prisma を直接 import", 'import { prisma } from "@/lib/prisma";', ["lib/x.test.ts", "lib/prisma.ts"]],
    ["相対パスで import", 'import { prisma } from "./prisma";', ["lib/x.test.ts", "lib/prisma.ts"]],
    ["テスト対象のモジュール経由", 'import { list } from "./repo";', ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"]],
    ["testHelpers 経由", 'import { fixture } from "@/lib/testHelpers";', ["lib/x.test.ts", "lib/testHelpers.ts", "lib/prisma.ts"]],
    ["再export の経由", 'import { list } from "./barrel";', ["lib/x.test.ts", "lib/barrel.ts", "lib/repo.ts", "lib/prisma.ts"]],
    ["動的import", 'const m = await import("./repo");', ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"]],
    ["require", 'const m = require("./repo");', ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"]],
    ["副作用import", 'import "./repo";', ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"]],
    ["pg の直接利用", 'import { Pool } from "pg";', ["lib/x.test.ts", "pg"]],
    ["自動モック（factory なし）", 'vi.mock("@/lib/prisma");\nimport { list } from "./repo";', ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"]],
    [
      "importOriginal を受け取る factory",
      'vi.mock("@/lib/prisma", async (orig) => orig());\nimport { list } from "./repo";',
      ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"],
    ],
    [
      "モックした後の vi.importActual",
      'vi.mock("@/lib/prisma", () => ({ prisma: {} }));\nawait vi.importActual("@/lib/prisma");',
      ["lib/x.test.ts", "lib/prisma.ts"],
    ],
    [
      "vi.unmock",
      'vi.mock("@/lib/prisma", () => ({ prisma: {} }));\nvi.unmock("@/lib/prisma");\nimport { list } from "./repo";',
      ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"],
    ],
    [
      "vi.doMock（順序に依存するので、モックとみなさない）",
      'vi.doMock("@/lib/prisma", () => ({ prisma: {} }));\nimport { list } from "./repo";',
      ["lib/x.test.ts", "lib/repo.ts", "lib/prisma.ts"],
    ],
    [
      "別のモジュールの importOriginal の先で、モックしていない Prisma",
      'vi.mock("@/lib/auth", async (orig) => ({ ...(await orig()) }));\nimport { ctx } from "@/lib/auth";',
      ["lib/x.test.ts", "lib/auth.ts", "lib/prisma.ts"],
    ],
  ])("%s はDBに到達する", (_name, source, dbPath) => {
    expect(analyze(source).dbPath).toEqual(dbPath);
  });

  it.each([
    ["DBを使わないモジュールだけを使う", 'import { add } from "./pure";'],
    ["型だけの import", 'import type { X } from "./types";\nimport type { prisma } from "@/lib/prisma";'],
    ["型だけの再export を経由する", 'import "./typeElements";'],
    ["Prisma の型・enum だけを使う", 'import { ProductStatus, type Prisma } from "@prisma/client";'],
    ["factory 付きの Prisma モック", 'vi.mock("@/lib/prisma", () => ({ prisma: {} }));\nimport { list } from "./repo";\nimport { prisma } from "@/lib/prisma";'],
    ["相対パスでモック", 'vi.mock("./prisma", () => ({ prisma: {} }));\nimport { list } from "@/lib/repo";'],
    ["テスト対象のモジュールのモック", 'vi.mock("./repo", () => ({ list: vi.fn() }));\nimport { list } from "./repo";'],
    ["import() を渡す形のモック", 'vi.mock(import("@/lib/prisma"), () => ({ prisma: {} }));\nimport { list } from "./repo";'],
    [
      "vi.importActual した先で、モック済みの Prisma を使う",
      'vi.mock("@/lib/prisma", () => ({ prisma: {} }));\nconst actual = await vi.importActual("@/lib/auth");',
    ],
    [
      "importOriginal した先で、モック済みの Prisma を使う",
      'vi.mock("@/lib/prisma", () => ({}));\nvi.mock("@/lib/auth", async (orig) => ({ ...(await orig()) }));\nimport { ctx } from "@/lib/auth";',
    ],
    ["循環 import", 'import { a } from "./cycleA";'],
    ["型引数の中の import 型", 'const x = await vi.importActual<typeof import("@/lib/prisma")>("./pure");'],
  ])("%s はDBに到達しない", (_name, source) => {
    expect(analyze(source)).toEqual({ dbPath: undefined, unverified: [] });
  });

  it.each([
    ["文字列以外の動的import", 'const name = "./repo";\nawait import(name);', "dynamic-import with a non-literal specifier"],
    ["文字列以外の require", "const m = require(process.env.M);", "require with a non-literal specifier"],
    ["解決できないローカルパス", 'import { y } from "./missing";', 'cannot resolve "./missing"'],
    ["文字列以外の vi.mock のパス", "const p = '@/lib/prisma';\nvi.mock(p, () => ({}));", "vi.mock with a non-literal path"],
    ["eval", 'eval("1");', "eval() cannot be analyzed"],
  ])("%s は未確認として報告する", (_name, source, detail) => {
    const result = analyze(source);
    expect(result.dbPath).toBeUndefined();
    expect(result.unverified.join("\n")).toContain(detail);
  });

  it("テストファイル以外での vi.mock は未確認として報告する", () => {
    const result = analyze('import "./helper";', { "lib/helper.ts": 'vi.mock("@/lib/prisma", () => ({}));' });
    expect(result.unverified).toEqual(["lib/helper.ts: vi.mock-like calls outside the test file"]);
  });

  it("モックを無視するオプションでは、factory 付きのモックでもDBに到達する", () => {
    const files = { ...base, "lib/x.test.ts": 'vi.mock("@/lib/prisma", () => ({}));\nimport { list } from "./repo";' };
    expect(analyzeDbDependency(memoryHost(files), "lib/x.test.ts", { honorMocks: false }).dbPath).toEqual([
      "lib/x.test.ts",
      "lib/repo.ts",
      "lib/prisma.ts",
    ]);
  });

  describe("命名との照合", () => {
    const files = {
      ...base,
      "lib/a.integration.test.ts": 'import { list } from "./repo";',
      "lib/b.test.ts": 'import { add } from "./pure";',
      "lib/c.test.ts": 'vi.mock("@/lib/prisma", () => ({}));\nimport { list } from "./repo";',
      "lib/d.test.ts": 'import { list } from "./repo";',
      "lib/e.integration.test.tsx": 'import { add } from "./pure";',
    };
    const host = memoryHost(files);

    it("DBに依存する統合テストと、DBに依存しない・モック経由の通常テストは許可する", () => {
      const audit = auditTestClassification(host, ["lib/a.integration.test.ts", "lib/b.test.ts", "lib/c.test.ts"], [
        "lib/a.integration.test.ts",
      ]);
      expect(audit).toEqual({
        unitTests: ["lib/b.test.ts", "lib/c.test.ts"],
        integrationTests: ["lib/a.integration.test.ts"],
        violations: [],
        unverified: [],
      });
    });

    it("通常テストの名前で追加されたDB依存テストを検出する", () => {
      expect(auditTestClassification(host, ["lib/d.test.ts"], []).violations).toEqual([
        "lib/d.test.ts: unit test reaches the real DB (lib/d.test.ts -> lib/repo.ts -> lib/prisma.ts)",
      ]);
    });

    it("DBに依存しないのに統合テストの名前のファイルを検出する", () => {
      expect(auditTestClassification(host, ["lib/e.integration.test.tsx"], []).violations).toEqual([
        "lib/e.integration.test.tsx: named as an integration test but does not reach the DB",
      ]);
    });

    it("既知のDB依存テストが、通常テストの名前に戻された・消えた場合を検出する", () => {
      const renamedBack = { ...files, "lib/a.test.ts": files["lib/a.integration.test.ts"] };
      const audit = auditTestClassification(memoryHost(renamedBack), ["lib/a.test.ts"], ["lib/a.integration.test.ts"]);
      expect(audit.violations).toEqual([
        "lib/a.test.ts: unit test reaches the real DB (lib/a.test.ts -> lib/repo.ts -> lib/prisma.ts)",
        "lib/a.integration.test.ts: known DB test is missing (renamed or deleted)",
      ]);
      expect(auditTestClassification(host, [], ["lib/a.test.ts"]).violations).toEqual([
        "lib/a.test.ts: known DB test is not named *.integration.test.*",
      ]);
    });
  });
});

describe("vitest.config.ts の検査器（規則4・インメモリのソース）", () => {
  const config = (test: string) =>
    `import { configDefaults, defineConfig } from "vitest/config";\nexport default defineConfig({ test: { environment: "node", ${test} } });`;
  const exclude = `exclude: [...configDefaults.exclude, "${INTEGRATION_TEST_GLOB}"]`;

  it("命名規則だけで除外する設定は許可する", () => {
    expect(vitestConfigIssues(config(exclude))).toEqual([]);
    expect(vitestConfigIssues(config(`${exclude}, include: ["**/*.test.{ts,tsx}"]`))).toEqual([]);
  });

  it.each([
    ["除外がない", "", "test.exclude must be"],
    ["統合テストのパターンがない", "exclude: [...configDefaults.exclude]", "test.exclude must be"],
    ["既定の除外を引き継がない", `exclude: ["${INTEGRATION_TEST_GLOB}"]`, "test.exclude must be"],
    ["明示リストを復活させる", `${exclude.slice(0, -1)}, ...DB_INTEGRATION_TEST_FILES]`, "DB_INTEGRATION_TEST_FILES must not be used"],
    ["include を広げる", `${exclude}, include: ["**/*.{test,spec}.ts"]`, "test.include must be absent"],
    ["setupFiles を追加する", `${exclude}, setupFiles: ["./setup.ts"]`, "test.setupFiles is not covered"],
    ["globalSetup を追加する", `${exclude}, globalSetup: "./global.ts"`, "test.globalSetup is not covered"],
  ])("%s 設定を検出する", (_name, test, issue) => {
    expect(vitestConfigIssues(config(test)).join("\n")).toContain(issue);
  });
});
