import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const [total, avgPrice, maxPrice, minPrice] = await Promise.all([
      prisma.katanaListing.count(),

      prisma.katanaListing.aggregate({
        _avg: {
          price: true,
        },
        where: {
          price: {
            not: null,
          },
        },
      }),

      prisma.katanaListing.aggregate({
        _max: {
          price: true,
        },
      }),

      prisma.katanaListing.aggregate({
        _min: {
          price: true,
        },
      }),
    ]);

    return NextResponse.json({
      total,
      averagePrice: avgPrice._avg.price,
      maxPrice: maxPrice._max.price,
      minPrice: minPrice._min.price,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Failed to fetch market summary",
      },
      {
        status: 500,
      },
    );
  }
}
