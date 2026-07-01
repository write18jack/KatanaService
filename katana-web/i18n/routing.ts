// i18n/routing.ts

import {defineRouting} from "next-intl/routing";

// next-intl のルーティング設定
// ここで、サポートするロケールや、デフォルトのロケールを定義する
// ルーティング設定は、next-intl の createNavigation や getRequestConfig などで使用される
export const routing = defineRouting({
  locales: ["ja", "en"],
  defaultLocale: "ja",
  localePrefix: "always",
});
