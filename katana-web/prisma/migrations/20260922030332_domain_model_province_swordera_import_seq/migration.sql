/*
  Warnings:

  - You are about to drop the column `traditionId` on the `Product` table. All the data in the column will be lost.
  - You are about to drop the `Tradition` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `swordEraId` to the `Product` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_traditionId_fkey";

-- AlterTable
ALTER TABLE "ImportRow" ADD COLUMN     "rawData" JSONB;

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "traditionId",
ADD COLUMN     "provinceId" TEXT,
ADD COLUMN     "swordEraId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextProductSequence" INTEGER NOT NULL DEFAULT 1;

-- DropTable
DROP TABLE "Tradition";

-- CreateTable
CREATE TABLE "Province" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Province_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwordEra" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SwordEra_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Province_name_key" ON "Province"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SwordEra_name_key" ON "SwordEra"("name");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_provinceId_fkey" FOREIGN KEY ("provinceId") REFERENCES "Province"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_swordEraId_fkey" FOREIGN KEY ("swordEraId") REFERENCES "SwordEra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
