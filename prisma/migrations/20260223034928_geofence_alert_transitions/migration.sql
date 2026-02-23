-- CreateTable
CREATE TABLE "DeviceGeofenceState" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "geofenceId" TEXT NOT NULL,
    "isInside" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceGeofenceState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceGeofenceState_geofenceId_idx" ON "DeviceGeofenceState"("geofenceId");

-- CreateIndex
CREATE INDEX "DeviceGeofenceState_deviceId_idx" ON "DeviceGeofenceState"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceGeofenceState_deviceId_geofenceId_key" ON "DeviceGeofenceState"("deviceId", "geofenceId");

-- AddForeignKey
ALTER TABLE "DeviceGeofenceState" ADD CONSTRAINT "DeviceGeofenceState_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceGeofenceState" ADD CONSTRAINT "DeviceGeofenceState_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "Geofence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
