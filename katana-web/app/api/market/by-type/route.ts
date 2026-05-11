import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// 刀種ごとの：
// 件数
// 平均価格
// 最高価格
// 最低価格

export async function GET() {
  try {
    const result = await prisma.katanaListing.groupBy({
      by: ["katanaType"],

      where: {
        price: {
          not: null,
        },
      },

      _count: {
        _all: true,
      },

      _avg: {
        price: true,
      },

      _max: {
        price: true,
      },

      _min: {
        price: true,
      },

      orderBy: {
        _count: {
          id: "desc",
        },
      },
    });

    return NextResponse.json(
      result.map((item) => ({
        katanaType: item.katanaType,

        count: item._count._all,

        averagePrice: item._avg.price,

        maxPrice: item._max.price,

        minPrice: item._min.price,
      })),
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Failed to fetch grouped market data",
      },
      {
        status: 500,
      },
    );
  }
}
