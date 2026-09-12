"use client";

import Link from "next/link";
import { Eye, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import DeleteProductDialog from "./DeleteProductDialog";

type ProductRowActionsProps = {
  productId: string;
  productName: string;
  onDelete: () => void;
};

export default function ProductRowActions({
  productId,
  productName,
  onDelete,
}: ProductRowActionsProps) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button variant="outline" size="icon" asChild>
        <Link href={`/dashboard/products/${productId}`}>
          <Eye className="h-4 w-4" />
        </Link>
      </Button>

      <Button variant="outline" size="icon" asChild>
        <Link href={`/dashboard/products/${productId}/edit`}>
          <Pencil className="h-4 w-4" />
        </Link>
      </Button>

      <DeleteProductDialog productName={productName} onDelete={onDelete} />
    </div>
  );
}
