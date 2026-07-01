// components/i18n/LocaleSwitcher.tsx

"use client";

import { useLocale } from "next-intl";

import { usePathname, useRouter } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const locale = useLocale();

  const router = useRouter();
  const pathname = usePathname();

  function handleChange(nextLocale: "ja" | "en") {
    router.replace(pathname, {
      locale: nextLocale,
    });
  }

  return (
    <select
      value={locale}
      onChange={(e) => handleChange(e.target.value as "ja" | "en")}
      className="rounded-md border px-3 py-2 text-sm"
    >
      <option value="ja">日本語</option>
      <option value="en">English</option>
    </select>
  );
}
