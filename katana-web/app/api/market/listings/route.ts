import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    // クエリ
    const katanaType = searchParams.get("katanaType");
    const era = searchParams.get("era");

    // pagination
    const page = Number(searchParams.get("page") || 1);
    const limit = Number(searchParams.get("limit") || 20);

    const skip = (page - 1) * limit;

    const listings = await prisma.katanaListing.findMany({
      where: {
        ...(katanaType && {
          katanaType: katanaType as any,
        }),

        ...(era && {
          era: era as any,
        }),
      },

      orderBy: {
        createdAt: "desc",
      },

      skip,
      take: limit,
    });

    const total = await prisma.katanaListing.count({
      where: {
        ...(katanaType && {
          katanaType: katanaType as any,
        }),

        ...(era && {
          era: era as any,
        }),
      },
    });

    return NextResponse.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),

      data: listings,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Failed to fetch listings",
      },
      {
        status: 500,
      },
    );
  }
}
F;
