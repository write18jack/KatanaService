"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react"; // アイコンを追加
import { Button } from "@/components/ui/button"; // 既存のButtonを使用
import { KatanaActionButtons } from "@/components/katana/KatanaActionButtons";
import { Katana as PrismaKatana } from "@prisma/client";

// Katana 型を外部（page.tsxなど）から参照できるように export をつける
export type Katana = PrismaKatana;

// Prisma が自動生成した Katana 型を直接インポートして使用する
export const columns: ColumnDef<Katana>[] = [
  {
    accessorKey: "shopName",
    header: "店舗名",
  },
  {
    accessorKey: "katanaType",
    header: "種別",
  },
  {
    accessorKey: "name",
    header: "品名",
  },
  {
    accessorKey: "era",
    header: "制作年代",
  },
  {
    accessorKey: "price",
    // ヘッダーをボタンにして、クリックでソートをトグルさせる
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          className="-ml-4" // 余白調整
        >
          価格
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue("price"));
      const formatted = new Intl.NumberFormat("ja-JP", {
        style: "currency",
        currency: "JPY",
      }).format(amount);
      return <div className="font-medium">{formatted}</div>;
    },
  },
  {
    accessorKey: "status",
    header: "状態",
  },
  {
    id: "actions",
    header: "操作",
    cell: ({ row }) => {
      // row.original にその行の刀剣データ（Katana型）が入ってる
      // コンポーネントにデータを渡してレンダリング
      return <KatanaActionButtons katana={row.original} />;
    },
  },
];
