-- CreateEnum
CREATE TYPE "KatanaType" AS ENUM ('KATANA', 'WAKIZASHI', 'TANTO', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Era" AS ENUM ('HEIAN', 'KAMAKURA', 'MUROMACHI', 'MOMOYAMA', 'EDO', 'MODERN', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Katana" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "KatanaRequest" ADD COLUMN     "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "KatanaListing" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER,
    "katanaType" "KatanaType" NOT NULL,
    "era" "Era" NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KatanaListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawListing" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listingId" TEXT NOT NULL,

    CONSTRAINT "RawListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KatanaListing_sourceUrl_key" ON "KatanaListing"("sourceUrl");

-- CreateIndex
CREATE INDEX "KatanaListing_katanaType_era_idx" ON "KatanaListing"("katanaType", "era");

-- CreateIndex
CREATE INDEX "KatanaListing_source_idx" ON "KatanaListing"("source");

-- CreateIndex
CREATE UNIQUE INDEX "RawListing_sourceUrl_key" ON "RawListing"("sourceUrl");

-- CreateIndex
CREATE UNIQUE INDEX "RawListing_listingId_key" ON "RawListing"("listingId");

-- CreateIndex
CREATE INDEX "PriceHistory_listingId_idx" ON "PriceHistory"("listingId");

-- CreateIndex
CREATE INDEX "PriceHistory_recordedAt_idx" ON "PriceHistory"("recordedAt");

-- AddForeignKey
ALTER TABLE "RawListing" ADD CONSTRAINT "RawListing_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "KatanaListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "KatanaListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
