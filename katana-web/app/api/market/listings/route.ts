import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const katanaType = searchParams.get("katanaType");

    const era = searchParams.get("era");

    const page = Number(searchParams.get("page")) || 1;

    const limit = Number(searchParams.get("limit")) || 20;

    const sort = searchParams.get("sort");

    const search = searchParams.get("search");

    const skip = (page - 1) * limit;

    // 共通where
    const where = {
      ...(katanaType && {
        katanaType: katanaType as any,
      }),

      ...(era && {
        era: era as any,
      }),

      ...(search && {
        name: {
          contains: search,
          mode: "insensitive" as const,
        },
      }),
    };

    const listings = await prisma.katanaListing.findMany({
      where,

      orderBy:
        sort === "price_asc"
          ? {
              price: "asc",
            }
          : sort === "price_desc"
            ? {
                price: "desc",
              }
            : {
                createdAt: "desc",
              },
      skip,
      take: limit,
    });

    const total = await prisma.katanaListing.count({
      where,
    });

    return NextResponse.json({
      page,
      limit,
      total,

      totalPages: Math.ceil(total / limit),
      era: era as any,
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
