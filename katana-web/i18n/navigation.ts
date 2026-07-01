import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// 普通の next/link だと locale が維持されない。
// なので、next-intl の createNavigation を使って、
// locale 対応の Link コンポーネントや useRouter フックを作成する。
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
