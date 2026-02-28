-- CreateTable
CREATE TABLE "Cattle" (
    "id" TEXT NOT NULL,
    "ranchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dob" TIMESTAMP(3),
    "photoUrl" TEXT,
    "lastCheckupAt" TIMESTAMP(3),
    "motherId" TEXT,
    "fatherId" TEXT,
    "currentDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cattle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cattle_ranchId_idx" ON "Cattle"("ranchId");

-- CreateIndex
CREATE INDEX "Cattle_currentDeviceId_idx" ON "Cattle"("currentDeviceId");

-- AddForeignKey
ALTER TABLE "Cattle" ADD CONSTRAINT "Cattle_motherId_fkey" FOREIGN KEY ("motherId") REFERENCES "Cattle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cattle" ADD CONSTRAINT "Cattle_fatherId_fkey" FOREIGN KEY ("fatherId") REFERENCES "Cattle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cattle" ADD CONSTRAINT "Cattle_currentDeviceId_fkey" FOREIGN KEY ("currentDeviceId") REFERENCES "Device"("deviceId") ON DELETE SET NULL ON UPDATE CASCADE;
