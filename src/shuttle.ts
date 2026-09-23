export type Point = { latitude: number; longitude: number };
export type Direction = 'to-current' | 'to-ssb';

export const stops = {
  ssb: { latitude: 34.05847, longitude: -117.81793 },
  current: { latitude: 34.06381, longitude: -117.80303 },
} satisfies Record<string, Point>;

export const ROUTE_WIDTH_METERS = 400;
export const MAX_ACCURACY_METERS = 100;
let activeRoute: Point[] = [stops.ssb, stops.current];

export function setRoutePath(path: Point[]) {
  if (path.length >= 2) activeRoute = path;
}

export function getRoutePath() {
  return activeRoute;
}
export type ScheduleFallback = {
  active: boolean;
  minutes?: number;
  time?: string;
  status: string;
};
const SCHEDULE_TIME_ZONE = 'America/Los_Angeles';

export function scheduleFallback(now = new Date()): ScheduleFallback {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIME_ZONE,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday ?? '');
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const minuteOfDay = hour * 60 + minute;
  const opens = 7 * 60 + 30;
  const closes = weekday === 5 ? 18 * 60 + 30 : 23 * 60;
  const lastPickup = closes - 30;

  if (weekday >= 1 && weekday <= 5 && minuteOfDay >= opens && minuteOfDay <= lastPickup) {
    const scheduledMinute = opens + Math.ceil((minuteOfDay - opens) / 30) * 30;
    const scheduledAt = new Date(now.getTime() + Math.max(0, scheduledMinute - minuteOfDay) * 60_000);
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: SCHEDULE_TIME_ZONE, hour: 'numeric', minute: '2-digit',
    }).format(scheduledAt);
    return {
      active: true,
      minutes: scheduledMinute - minuteOfDay,
      time,
      status: 'Scheduled every 30 min during regular weekday hours.',
    };
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const nextWeekday = (weekday + daysAhead) % 7;
    if (nextWeekday < 1 || nextWeekday > 5) continue;
    if (daysAhead === 0 && minuteOfDay < opens) {
      return { active: false, status: `Next regular schedule: today at 7:30 AM.` };
    }
    return { active: false, status: `Next regular schedule: ${dayNames[nextWeekday]} at 7:30 AM.` };
  }
  return { active: false, status: 'No scheduled service.' };
}

export function routeLength(path = activeRoute) {
  return path.slice(1).reduce((length, point, index) => length + distanceMeters(path[index]!, point), 0);
}

export function pointAtRouteProgress(progress: number, path = activeRoute): Point {
  const lengths = path.slice(1).map((point, index) => distanceMeters(path[index]!, point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = Math.max(0, Math.min(1, progress)) * total;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!;
    if (remaining <= length || index === lengths.length - 1) {
      const start = path[index]!;
      const end = path[index + 1]!;
      const fraction = length ? remaining / length : 0;
      return { latitude: start.latitude + (end.latitude - start.latitude) * fraction, longitude: start.longitude + (end.longitude - start.longitude) * fraction };
    }
    remaining -= length;
  }
  return path[0]!;
}

export function routePosition(point: Point, path = activeRoute) {
  let traversedMeters = 0;
  let closest = { progress: 0, crossTrackMeters: Infinity };
  const totalMeters = routeLength(path);
  for (let index = 0; index < path.length - 1; index++) {
    const start = path[index]!;
    const end = path[index + 1]!;
    const latitudeScale = 111_320;
    const longitudeScale = latitudeScale * Math.cos(((start.latitude + end.latitude + point.latitude) / 3) * Math.PI / 180);
    const dx = (end.longitude - start.longitude) * longitudeScale;
    const dy = (end.latitude - start.latitude) * latitudeScale;
    const px = (point.longitude - start.longitude) * longitudeScale;
    const py = (point.latitude - start.latitude) * latitudeScale;
    const lengthSquared = dx * dx + dy * dy;
    const segmentMeters = Math.sqrt(lengthSquared);
    const fraction = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
    const crossTrackMeters = Math.hypot(px - fraction * dx, py - fraction * dy);
    if (crossTrackMeters < closest.crossTrackMeters) closest = { progress: totalMeters ? (traversedMeters + fraction * segmentMeters) / totalMeters : 0, crossTrackMeters };
    traversedMeters += segmentMeters;
  }
  return { progress: closest.progress, rawProgress: closest.progress, crossTrackMeters: closest.crossTrackMeters, routeLengthMeters: totalMeters };
}

export function distanceMeters(a: Point, b: Point) {
  const latitude = ((a.latitude + b.latitude) / 2) * Math.PI / 180;
  return Math.hypot(
    (a.latitude - b.latitude) * 111_320,
    (a.longitude - b.longitude) * 111_320 * Math.cos(latitude),
  );
}

export function etaRange(point: Point, direction: Direction, target: 'ssb' | 'current', speedMps: number, path = activeRoute) {
  const { progress, routeLengthMeters } = routePosition(point, path);
  const targetProgress = target === 'current' ? 1 : 0;
  const remaining = Math.abs(targetProgress - progress) * routeLengthMeters;
  const speed = Math.max(2, Math.min(12, speedMps));
  let lowSeconds = remaining / (speed * 1.25);
  let highSeconds = remaining / (speed * 0.7);

  // If the shuttle is heading away from this pickup, it must finish its leg,
  // wait at the end, then travel back to the pickup.
  const headingToTarget = (direction === 'to-current' && target === 'current') || (direction === 'to-ssb' && target === 'ssb');
  if (!headingToTarget) {
    const turnaroundMeters = target === 'current'
      ? (progress + 1) * routeLengthMeters
      : (2 - progress) * routeLengthMeters;
    lowSeconds = turnaroundMeters / (speed * 1.25) + 60;
    highSeconds = turnaroundMeters / (speed * 0.7) + 180;
  }

  const roundMinutes = (seconds: number) => Math.max(0, Math.round(seconds / 60));
  const next = { min: roundMinutes(lowSeconds), max: Math.max(1, roundMinutes(highSeconds)) };
  const circuitLow = (2 * routeLengthMeters) / (speed * 1.25) + 120;
  const circuitHigh = (2 * routeLengthMeters) / (speed * 0.7) + 360;
  return {
    next,
    following: {
      min: next.min + roundMinutes(circuitLow),
      max: next.max + roundMinutes(circuitHigh),
    },
  };
}
