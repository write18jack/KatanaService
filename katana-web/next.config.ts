import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Excel/CSVインポートのファイルアップロードのため既定の1MBから引き上げ
      bodySizeLimit: "10mb",
    },
  },
};

export default withNextIntl(nextConfig);
