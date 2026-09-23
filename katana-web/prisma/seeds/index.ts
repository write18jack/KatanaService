import { PrismaClient } from "@prisma/client";

import { makers } from "./makers";
import { grades } from "./grades";
import { ranks } from "./ranks";
import { periods } from "./periods";
import { provinces } from "./provinces";
import { categories } from "./categories";
import { swordEras } from "./swordEras";
import { appraisers } from "./appraisers";

export async function seedMaster(prisma: PrismaClient) {
  await prisma.maker.createMany({
    data: makers,
    skipDuplicates: true,
  });

  await prisma.grade.createMany({
    data: grades,
    skipDuplicates: true,
  });

  await prisma.rank.createMany({
    data: ranks,
    skipDuplicates: true,
  });

  await prisma.period.createMany({
    data: periods,
    skipDuplicates: true,
  });

  await prisma.province.createMany({
    data: provinces,
    skipDuplicates: true,
  });

  await prisma.category.createMany({
    data: categories,
    skipDuplicates: true,
  });

  await prisma.swordEra.createMany({
    data: swordEras,
    skipDuplicates: true,
  });

  await prisma.appraiser.createMany({
    data: appraisers,
    skipDuplicates: true,
  });
}
