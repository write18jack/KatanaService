import { TableCell, TableRow } from "@/components/ui/table";

import ProductStatusBadge from "./ProductStatusBadge";
import ProductRowActions from "./ProductRowActions";

type Product = {
  id: string;
  managementNumber: string;
  name: string;
  price: number | null;
  status: string;
};

type ProductRowProps = {
  product: Product;
  onDelete: (productId: string) => void;
};

export default function ProductRow({ product, onDelete }: ProductRowProps) {
  return (
    <TableRow>
      {/* 管理番号 */}
      <TableCell className="font-medium">{product.managementNumber}</TableCell>

      {/* 銘 */}
      <TableCell>{product.name}</TableCell>

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
          productName={product.name}
          onDelete={() => onDelete(product.id)}
        />
      </TableCell>
    </TableRow>
  );
}
