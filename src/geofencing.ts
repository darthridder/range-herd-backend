// ─── Geofencing Utilities ────────────────────────────────────────────────────

// Haversine formula - calculate distance between two GPS points in meters
export function getDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Check if a point is inside a circle geofence
export function isPointInCircle(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radiusM: number
): boolean {
  const distance = getDistanceMeters(lat, lon, centerLat, centerLon);
  return distance <= radiusM;
}

// Ray casting algorithm - check if point is inside polygon
export function isPointInPolygon(
  lat: number,
  lon: number,
  polygon: Array<[number, number]>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1];
    const yi = polygon[i][0];
    const xj = polygon[j][1];
    const yj = polygon[j][0];

    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }
  return inside;
}

// Check if a GPS point is inside any geofence
export function checkGeofences(
  lat: number,
  lon: number,
  geofences: Array<{
    id: string;
    type: string;
    centerLat: number | null;
    centerLon: number | null;
    radiusM: number | null;
    polygon: unknown;
  }>
): { inside: boolean; geofenceId: string | null } {
  for (const fence of geofences) {
    if (isInsideGeofence(lat, lon, fence)) {
      return { inside: true, geofenceId: fence.id };
    }
  }
  return { inside: false, geofenceId: null };
}

// Check if a point is inside a specific geofence.
// NOTE: polygon points are stored in DB as [lat, lon] pairs.
export function isInsideGeofence(
  lat: number,
  lon: number,
  fence: {
    type: string;
    centerLat: number | null;
    centerLon: number | null;
    radiusM: number | null;
    polygon: unknown;
  }
): boolean {
  if (fence.type === "circle") {
    if (fence.centerLat == null || fence.centerLon == null || fence.radiusM == null) return false;
    return isPointInCircle(lat, lon, fence.centerLat, fence.centerLon, fence.radiusM);
  }

  if (fence.type === "polygon") {
    if (!fence.polygon || !Array.isArray(fence.polygon)) return false;
    return isPointInPolygon(lat, lon, fence.polygon as Array<[number, number]>);
  }

  return false;
}
