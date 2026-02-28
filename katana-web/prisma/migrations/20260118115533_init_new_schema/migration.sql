-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Katana" (
    "id" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "katanaType" TEXT NOT NULL,
    "era" TEXT,
    "price" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Katana_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KatanaRequest" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "crudType" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "katanaType" TEXT NOT NULL,
    "era" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "applicantId" TEXT NOT NULL,
    "targetKatanaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KatanaRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_name_key" ON "User"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Katana" ADD CONSTRAINT "Katana_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KatanaRequest" ADD CONSTRAINT "KatanaRequest_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KatanaRequest" ADD CONSTRAINT "KatanaRequest_targetKatanaId_fkey" FOREIGN KEY ("targetKatanaId") REFERENCES "Katana"("id") ON DELETE SET NULL ON UPDATE CASCADE;
