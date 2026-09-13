"use client";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import ProductRow from "./ProductRow";
import EmptyState from "./EmptyState";

type Product = {
  id: string;
  managementNumber: string;
  name: string;
  price: number | null;
  status: string;
};

type ProductTableProps = {
  products: Product[];
};

export default function ProductTable({ products }: ProductTableProps) {
  if (products.length === 0) {
    return <EmptyState />;
  }

  const handleDelete = (productId: string) => {
    console.log("Delete product:", productId);
  };

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>管理番号</TableHead>
            <TableHead>銘</TableHead>
            <TableHead>価格</TableHead>
            <TableHead>状態</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {products.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              onDelete={handleDelete}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
