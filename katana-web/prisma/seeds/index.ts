import { PrismaClient } from "@prisma/client";

import { makers } from "./makers";
import { grades } from "./grades";
import { ranks } from "./ranks";
import { periods } from "./periods";
import { traditions } from "./traditions";
import { categories } from "./categories";
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

  await prisma.tradition.createMany({
    data: traditions,
    skipDuplicates: true,
  });

  await prisma.category.createMany({
    data: categories,
    skipDuplicates: true,
  });

  await prisma.appraiser.createMany({
    data: appraisers,
    skipDuplicates: true,
  });
}
