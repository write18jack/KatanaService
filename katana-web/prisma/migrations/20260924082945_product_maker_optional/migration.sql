-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_makerId_fkey";

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "makerId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_makerId_fkey" FOREIGN KEY ("makerId") REFERENCES "Maker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
