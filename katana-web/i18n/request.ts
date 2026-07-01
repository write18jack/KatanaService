// i18n/request.ts

import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";

import { routing } from "./routing";

// next-intl のリクエストハンドラー
// クライアントからのリクエストを受けて、
// - 適切な locale を判定
// - 対応する翻訳ファイルを読み込む
// という処理を行う
export default getRequestConfig(async ({ requestLocale }) => {
  const locale = await requestLocale;

  if (!hasLocale(routing.locales, locale)) {
    return {
      locale: routing.defaultLocale,
      messages: (await import(`../messages/${routing.defaultLocale}.json`))
        .default,
    };
  }

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
