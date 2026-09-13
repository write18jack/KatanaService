import { PrismaClient } from "@prisma/client";
import { seedMaster } from "./seeds";

// ロジェクト全体のエントリーポイント

const prisma = new PrismaClient();

async function main() {
  await seedMaster(prisma);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("✅ Master data seeded.");
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
