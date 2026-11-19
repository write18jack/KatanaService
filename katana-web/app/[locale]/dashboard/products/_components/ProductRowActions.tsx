"use client";

import Link from "next/link";
import { ProductStatus } from "@prisma/client";
import { Eye, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import DeleteProductDialog from "./DeleteProductDialog";
import MarkSoldDialog from "./MarkSoldDialog";

type ProductRowActionsProps = {
  productId: string;
  productCode: string;
  productTitle: string;
  status: ProductStatus;
  onDelete: () => void;
};

export default function ProductRowActions({
  productId,
  productCode,
  productTitle,
  status,
  onDelete,
}: ProductRowActionsProps) {
  return (
    <div className="flex items-center justify-end gap-2">
      {status === "ACTIVE" && (
        <MarkSoldDialog
          productId={productId}
          productCode={productCode}
          productTitle={productTitle}
        />
      )}

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

      <DeleteProductDialog productName={productTitle} onDelete={onDelete} />
    </div>
  );
}
