"use client";

import { Input } from "@/components/ui/input";

type ProductSearchProps = {
  value: string;
  onChange: (value: string) => void;
};

export default function ProductSearch({ value, onChange }: ProductSearchProps) {
  return (
    <div className="w-full max-w-sm">
      <Input
        placeholder="管理番号・銘で検索..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
