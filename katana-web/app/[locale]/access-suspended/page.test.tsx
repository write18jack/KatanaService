import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ja from "@/messages/ja.json";

// 実際の翻訳ファイル（ja/en）から文言を引く
vi.mock("next-intl/server", async () => {
  const messages = { ja: (await import("@/messages/ja.json")).default, en: (await import("@/messages/en.json")).default };
  return {
    getTranslations: async ({ locale, namespace }: { locale: "ja" | "en"; namespace: string }) => (key: string) =>
      (messages[locale] as unknown as Record<string, Record<string, string>>)[namespace][key],
  };
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signOut: vi.fn(),
}));

// 停止画面はDBに触れない（参照されたら即座に失敗させる）
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        throw new Error("アクセス停止画面からDBを参照してはいけない");
      },
    },
  ),
}));

import { auth, signOut } from "@/auth";
import { logoutFromSuspended } from "./actions";
import AccessSuspendedPage from "./page";

function texts(node: ReactNode): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return texts(node.props.children);
}

function findForm(node: ReactNode): ReactElement<{ action: () => Promise<void>; children?: ReactNode }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findForm(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; action?: () => Promise<void> }>(node)) return null;
  if (node.type === "form") return node as ReactElement<{ action: () => Promise<void>; children?: ReactNode }>;
  return findForm(node.props.children);
}

function renderPage(locale: string) {
  return AccessSuspendedPage({ params: Promise.resolve({ locale }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("アクセス停止画面", () => {
  it.each([
    ["ja", ja.AccessSuspended],
    ["en", en.AccessSuspended],
  ] as const)("%s ロケールでは、その言語の見出し・説明・ログアウトボタンを表示する", async (locale, expected) => {
    const tree = await renderPage(locale);

    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining([expected.title, expected.description, expected.logout]));
    const form = findForm(tree);
    expect(form).not.toBeNull();
    expect(texts(form!.props.children)).toContain(expected.logout);
  });

  it("日本語・英語の文言は確定仕様どおり", () => {
    expect(ja.AccessSuspended).toEqual({
      title: "アクセスが停止されています",
      description: "現在、このアカウントではダッシュボードを利用できません。利用再開については管理者にお問い合わせください。",
      logout: "ログアウト",
    });
    expect(en.AccessSuspended).toEqual({
      title: "Access suspended",
      description: "This account cannot access the dashboard at the moment. Please contact your administrator for assistance.",
      logout: "Log out",
    });
  });

  it("画面を開いただけではログアウトせず、セッション確認やDB参照もしない", async () => {
    await renderPage("ja");

    expect(signOut).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it("停止の内部理由（ユーザー削除・店舗無効）や店舗・ユーザー情報を表示しない", async () => {
    const shown = texts(await renderPage("ja")).join(" ");

    for (const secret of ["SHOP_INACTIVE", "USER_NOT_FOUND", "UNAUTHENTICATED", "削除", "無効", "店舗"]) {
      expect(shown).not.toContain(secret);
    }
  });

  it.each([
    ["ja", "/ja/login"],
    ["en", "/en/login"],
  ])("%s ロケールのログアウトボタンを押すと、Auth.jsの signOut でその言語のログイン画面へ移動する", async (locale, target) => {
    const form = findForm(await renderPage(locale));
    expect(signOut).not.toHaveBeenCalled();

    await form!.props.action();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ redirectTo: target });
  });
});

describe("logoutFromSuspended", () => {
  it.each(["fr", "", "/evil", "https://example.com"])("対応外のロケール %j は既定ロケール（ja）のログイン画面へ移動する", async (locale) => {
    await logoutFromSuspended(locale);

    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/ja/login" });
  });
});
