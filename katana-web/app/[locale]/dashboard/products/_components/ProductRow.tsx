import { ProductStatus } from "@prisma/client";
import { TableCell, TableRow } from "@/components/ui/table";

import ProductStatusBadge from "./ProductStatusBadge";
import ProductRowActions from "./ProductRowActions";

export type ProductRowData = {
  id: string;
  productCode: string;
  title: string;
  price: number | null;
  status: ProductStatus;
};

type ProductRowProps = {
  product: ProductRowData;
  onDelete: (productId: string) => void;
};

export default function ProductRow({ product, onDelete }: ProductRowProps) {
  return (
    <TableRow>
      {/* 管理番号 */}
      <TableCell className="font-medium">{product.productCode}</TableCell>

      {/* 銘 */}
      <TableCell>{product.title}</TableCell>

      {/* 価格 */}
      <TableCell>
        {product.price !== null ? `¥${product.price.toLocaleString()}` : "-"}
      </TableCell>

      {/* ステータス */}
      <TableCell>
        <ProductStatusBadge status={product.status} />
      </TableCell>

      {/* 操作 */}
      <TableCell>
        <ProductRowActions
          productId={product.id}
          productCode={product.productCode}
          productTitle={product.title}
          status={product.status}
          onDelete={() => onDelete(product.id)}
        />
      </TableCell>
    </TableRow>
  );
}
