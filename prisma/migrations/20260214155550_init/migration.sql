-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "devEui" TEXT,
    "name" TEXT,
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Telemetry" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "altM" DOUBLE PRECISION,
    "batteryV" DOUBLE PRECISION,
    "batteryPct" DOUBLE PRECISION,
    "tempC" DOUBLE PRECISION,
    "humidityPct" DOUBLE PRECISION,
    "pressureHpa" DOUBLE PRECISION,
    "rssi" DOUBLE PRECISION,
    "snr" DOUBLE PRECISION,
    "fCnt" INTEGER,
    "raw" JSONB,

    CONSTRAINT "Telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceId_key" ON "Device"("deviceId");

-- CreateIndex
CREATE INDEX "Telemetry_deviceId_receivedAt_idx" ON "Telemetry"("deviceId", "receivedAt");

-- AddForeignKey
ALTER TABLE "Telemetry" ADD CONSTRAINT "Telemetry_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("deviceId") ON DELETE RESTRICT ON UPDATE CASCADE;
