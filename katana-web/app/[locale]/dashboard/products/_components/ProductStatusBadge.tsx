import { ProductStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";

type ProductStatusBadgeProps = {
  status: ProductStatus;
};

export default function ProductStatusBadge({
  status,
}: ProductStatusBadgeProps) {
  switch (status) {
    case "ACTIVE":
      return <Badge>販売中</Badge>;

    case "SOLD":
      return <Badge variant="secondary">売約済</Badge>;

    default:
      return <Badge variant="destructive">不明</Badge>;
  }
}
