export type Point = { latitude: number; longitude: number };
export type Direction = 'to-current' | 'to-ssb';

export const stops = {
  ssb: { latitude: 34.05847, longitude: -117.81793 },
  current: { latitude: 34.0644634, longitude: -117.8036599 },
} satisfies Record<string, Point>;

export const ROUTE_WIDTH_METERS = 400;
export const MAX_ACCURACY_METERS = 100;
// ponytail: endpoint-only route model uses a 1.3 road-distance allowance; replace with a traced shuttle path when ride observations show ETA drift.
const ROAD_DISTANCE_FACTOR = 1.3;

export function routePosition(point: Point) {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(((stops.ssb.latitude + stops.current.latitude) / 2) * Math.PI / 180);
  const dx = (stops.current.longitude - stops.ssb.longitude) * longitudeScale;
  const dy = (stops.current.latitude - stops.ssb.latitude) * latitudeScale;
  const px = (point.longitude - stops.ssb.longitude) * longitudeScale;
  const py = (point.latitude - stops.ssb.latitude) * latitudeScale;
  const lengthSquared = dx * dx + dy * dy;
  const rawProgress = (px * dx + py * dy) / lengthSquared;
  const progress = Math.max(0, Math.min(1, rawProgress));
  const crossTrackMeters = Math.hypot(px - progress * dx, py - progress * dy);
  return { progress, rawProgress, crossTrackMeters, routeLengthMeters: Math.sqrt(lengthSquared) };
}

export function distanceMeters(a: Point, b: Point) {
  const latitude = ((a.latitude + b.latitude) / 2) * Math.PI / 180;
  return Math.hypot(
    (a.latitude - b.latitude) * 111_320,
    (a.longitude - b.longitude) * 111_320 * Math.cos(latitude),
  );
}

export function etaRange(point: Point, direction: Direction, target: 'ssb' | 'current', speedMps: number) {
  const { progress, routeLengthMeters } = routePosition(point);
  const targetProgress = target === 'current' ? 1 : 0;
  const remaining = Math.abs(targetProgress - progress) * routeLengthMeters * ROAD_DISTANCE_FACTOR;
  const speed = Math.max(2, Math.min(12, speedMps));
  let lowSeconds = remaining / (speed * 1.25);
  let highSeconds = remaining / (speed * 0.7);

  // If the shuttle is heading away from this pickup, it must finish its leg,
  // wait at the end, then travel back to the pickup.
  const headingToTarget = (direction === 'to-current' && target === 'current') || (direction === 'to-ssb' && target === 'ssb');
  if (!headingToTarget) {
    const turnaroundMeters = target === 'current'
      ? (progress + 1) * routeLengthMeters * ROAD_DISTANCE_FACTOR
      : (2 - progress) * routeLengthMeters * ROAD_DISTANCE_FACTOR;
    lowSeconds = turnaroundMeters / (speed * 1.25) + 60;
    highSeconds = turnaroundMeters / (speed * 0.7) + 180;
  }

  const roundMinutes = (seconds: number) => Math.max(0, Math.round(seconds / 60));
  const next = { min: roundMinutes(lowSeconds), max: Math.max(1, roundMinutes(highSeconds)) };
  const circuitLow = (2 * routeLengthMeters * ROAD_DISTANCE_FACTOR) / (speed * 1.25) + 120;
  const circuitHigh = (2 * routeLengthMeters * ROAD_DISTANCE_FACTOR) / (speed * 0.7) + 360;
  return {
    next,
    following: {
      min: next.min + roundMinutes(circuitLow),
      max: next.max + roundMinutes(circuitHigh),
    },
  };
}
