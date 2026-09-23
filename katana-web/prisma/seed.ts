import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { seedMaster } from "./seeds";

// ロジェクト全体のエントリーポイント

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

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
