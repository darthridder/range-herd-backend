/*
  Warnings:

  - The `severity` column on the `Alert` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `type` on the `Alert` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `type` on the `Geofence` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "GeofenceType" AS ENUM ('circle', 'polygon');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('geofence_enter', 'geofence_exit', 'low_battery', 'inactivity');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('low', 'medium', 'high');

-- AlterTable
ALTER TABLE "Alert" ALTER COLUMN "geofenceId" DROP NOT NULL,
DROP COLUMN "type",
ADD COLUMN     "type" "AlertType" NOT NULL,
DROP COLUMN "severity",
ADD COLUMN     "severity" "AlertSeverity" NOT NULL DEFAULT 'medium';

-- AlterTable
ALTER TABLE "Geofence" DROP COLUMN "type",
ADD COLUMN     "type" "GeofenceType" NOT NULL;

-- CreateIndex
CREATE INDEX "Ranch_ownerId_idx" ON "Ranch"("ownerId");
