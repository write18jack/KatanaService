import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const type = searchParams.get("type"); // KATANA
  const era = searchParams.get("era"); // EDO

  const result = await prisma.katanaListing.aggregate({
    _avg: {
      price: true,
    },
    where: {
      price: {
        not: null,
      },
      ...(type && { katanaType: type as any }),
      ...(era && { era: era as any }),
    },
  });

  return NextResponse.json({
    avgPrice: result._avg.price,
  });
}
