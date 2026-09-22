import { animate } from 'motion/mini';
import { generateClipPath, observeResize } from '@lisse/core';
import { initializeMap, updateShuttleMarker } from './map';
import { MAX_ACCURACY_METERS, ROUTE_WIDTH_METERS, distanceMeters, routePosition, stops, type Direction, type Point } from '../shuttle';
import './alert-sheet';

const destinationHeading = document.querySelector<HTMLHeadingElement>('#destination');
const destinationButton = document.querySelector<HTMLButtonElement>('.page-indicator');
const destinationDots = destinationButton?.querySelectorAll<HTMLElement>('i');
const arrivals = document.querySelector<HTMLElement>('.arrivals');
const mapSection = document.querySelector<HTMLElement>('.map-section');
const sharingButton = document.querySelector<HTMLButtonElement>('#sharing-button');
const sharingStatus = document.querySelector<HTMLElement>('#sharing-status');
const nextRange = document.querySelector<HTMLElement>('#next-range');
const nextDetail = document.querySelector<HTMLElement>('#next-detail');
const followingRange = document.querySelector<HTMLElement>('#following-range');
const followingDetail = document.querySelector<HTMLElement>('#following-detail');
const destinations = ['the current', 'cal poly pomona'];
let destinationIndex = 0;
let routeChosenManually = false;

function setDestination(index: number, automatic = false) {
  if (!automatic) routeChosenManually = true;
  const heading = destinationHeading;
  const destination = destinations[index];
  if (!heading || !destinationButton || !destinationDots || !destination || index === destinationIndex) return;

  destinationIndex = index;
  heading.textContent = destination;
  renderEstimate(lastEstimate);
  destinationButton.setAttribute('aria-label', `Change destination, currently ${index + 1} of 2: ${destination}`);
  destinationDots.forEach((dot, dotIndex) => dot.classList.toggle('is-active', dotIndex === index));

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    animate(heading, { opacity: [0, 1], transform: ['translateY(5px)', 'translateY(0)'] }, {
      duration: 0.18, ease: [0.23, 1, 0.32, 1],
    });
  }
}

let suppressPagerClick = false;
destinationButton?.addEventListener('click', (event) => {
  if (suppressPagerClick) {
    suppressPagerClick = false;
    event.preventDefault();
    return;
  }
  setDestination(1 - destinationIndex);
});

function enableRouteSwipe(surface: HTMLElement | null, capture = false) {
  let swipeStart: { x: number; y: number; pointerId: number; target: EventTarget | null } | undefined;
  surface?.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest('button, a, input')) return;
    swipeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, target: event.target };
  }, capture);
  surface?.addEventListener('pointerup', (event) => {
    if (!swipeStart || event.pointerId !== swipeStart.pointerId) return;
    const deltaX = event.clientX - swipeStart.x;
    const deltaY = event.clientY - swipeStart.y;
    const startedOnPager = destinationButton?.contains(swipeStart.target as Node) ?? false;
    const endedOnPager = destinationButton?.contains(event.target as Node) ?? false;
    swipeStart = undefined;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
    if (startedOnPager || endedOnPager) {
      suppressPagerClick = true;
      setTimeout(() => { suppressPagerClick = false; }, 0);
    }
    const direction = deltaX < 0 ? 1 : -1;
    setDestination((destinationIndex + direction + destinations.length) % destinations.length);
  }, capture);
  surface?.addEventListener('pointercancel', () => { swipeStart = undefined; }, capture);
}

enableRouteSwipe(arrivals);
enableRouteSwipe(mapSection, true);

type Estimate = {
  latitude: number; longitude: number; direction: Direction; updatedAt: number;
  contributors: number; arrivals: Record<'ssb' | 'current', {
    next: { min: number; max: number }; following: { min: number; max: number };
  }>;
};
type LocationReading = Point & { accuracy: number; at: number; progress: number; speedMps: number };
let locationWatch: number | undefined;
let socket: WebSocket | undefined;
let sessionId: string | undefined;
let rideDirection: Direction | undefined;
let sessionActivityAt = 0;
let latestReport: LocationReading | undefined;
let lastSentAt = 0;
let readings: LocationReading[] = [];
let lastEstimate: Estimate | null = null;

function formatRange(range: { min: number; max: number }) {
  return range.min === range.max ? `${range.min} min` : `${range.min}–${range.max} min`;
}

function renderEstimate(estimate: Estimate | null) {
  lastEstimate = estimate;
  if (!estimate || Date.now() - estimate.updatedAt > 75_000) {
    updateShuttleMarker(null);
    nextRange && (nextRange.textContent = '—');
    nextDetail && (nextDetail.textContent = 'Live ETA unavailable');
    followingRange && (followingRange.textContent = '—');
    followingDetail && (followingDetail.textContent = 'Unavailable');
    return;
  }
  updateShuttleMarker(estimate);
  const arrivals = estimate.arrivals[destinationIndex === 0 ? 'current' : 'ssb'];
  nextRange && (nextRange.textContent = formatRange(arrivals.next));
  const ageSeconds = Math.max(0, Math.floor((Date.now() - estimate.updatedAt) / 1000));
  nextDetail && (nextDetail.textContent = `Estimated · updated ${ageSeconds < 10 ? 'just now' : `${ageSeconds}s ago`}`);
  followingRange && (followingRange.textContent = formatRange(arrivals.following));
  followingDetail && (followingDetail.textContent = 'Next circuit · estimate');
}

function connectFeed() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = connection;
  connection.addEventListener('open', () => {
    if (latestReport && sessionId) sendReport(latestReport);
  });
  connection.addEventListener('message', ({ data }) => {
    try {
      const message = JSON.parse(String(data)) as { type?: string; estimate?: Estimate | null };
      if (message.type === 'snapshot') renderEstimate(message.estimate ?? null);
    } catch { /* Ignore malformed feed updates. */ }
  });
  connection.addEventListener('close', () => {
    if (socket === connection) setTimeout(connectFeed, 3_000);
  });
  connection.addEventListener('error', () => connection.close());
}

function sendReport(reading: LocationReading) {
  if (!sessionId || !socket || socket.readyState !== WebSocket.OPEN || Date.now() - lastSentAt < 8_000) return;
  const direction = rideDirection;
  if (!direction) return;
  socket.send(JSON.stringify({
    type: 'location', sessionId, latitude: reading.latitude, longitude: reading.longitude,
    accuracy: reading.accuracy, direction, speedMps: reading.speedMps,
  }));
  lastSentAt = Date.now();
  sessionActivityAt = lastSentAt;
}

function stopSharing(status = 'Location sharing is off.') {
  if (locationWatch !== undefined) navigator.geolocation?.clearWatch(locationWatch);
  locationWatch = undefined;
  if (sessionId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
  sessionId = undefined;
  rideDirection = undefined;
  sessionActivityAt = 0;
  latestReport = undefined;
  readings = [];
  sharingButton && (sharingButton.textContent = 'Enable location for shared ETAs');
  sharingStatus && (sharingStatus.textContent = status);
}

function distanceToNearestStop(point: Point) {
  return Math.min(distanceMeters(point, stops.ssb), distanceMeters(point, stops.current));
}

function handleLocation(position: GeolocationPosition) {
  if (sessionId && Date.now() - sessionActivityAt > 75_000) {
    socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'stop' }));
    sessionId = undefined;
    rideDirection = undefined;
    sessionActivityAt = 0;
    readings = [];
  }
  const { latitude, longitude, accuracy, speed } = position.coords;
  const point = { latitude, longitude };
  if (accuracy > MAX_ACCURACY_METERS) {
    if (!sessionId && sharingStatus) sharingStatus.textContent = 'Waiting for a more accurate location…';
    return;
  }
  const route = routePosition(point);
  if (route.crossTrackMeters > ROUTE_WIDTH_METERS || route.rawProgress < -0.1 || route.rawProgress > 1.1) {
    if (sessionId) {
      socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'stop' }));
      sessionId = undefined;
      rideDirection = undefined;
      sessionActivityAt = 0;
      latestReport = undefined;
      sharingStatus && (sharingStatus.textContent = 'No longer on the shuttle route. Waiting near a pickup point.');
    }
    readings = [];
    return;
  }

  const at = position.timestamp || Date.now();
  const previous = readings.at(-1);
  const derivedSpeed = previous ? distanceMeters(previous, point) / Math.max(1, (at - previous.at) / 1000) : 0;
  const reading: LocationReading = {
    ...point, accuracy, at, progress: route.progress,
    speedMps: Math.max(0, Math.min(15, speed === null ? derivedSpeed : speed)),
  };
  readings.push(reading);
  readings = readings.filter((item) => at - item.at < 90_000).slice(-8);

  if (sessionId && readings.length >= 3) {
    const recentStart = readings.at(-3);
    const delta = recentStart ? reading.progress - recentStart.progress : 0;
    const turnDirection = delta > 0.025 ? 'to-current' : delta < -0.025 ? 'to-ssb' : undefined;
    if (turnDirection && turnDirection !== rideDirection && distanceToNearestStop(point) <= 250) {
      rideDirection = turnDirection;
      lastSentAt = 0;
      sharingStatus && (sharingStatus.textContent = 'Shuttle turnaround detected. Updating shared direction.');
    }
  }

  if (!routeChosenManually && distanceToNearestStop(point) < 250) {
    setDestination(distanceMeters(point, stops.current) < distanceMeters(point, stops.ssb) ? 0 : 1, true);
  }

  if (!sessionId) {
    const first = readings[0];
    if (!first) return;
    const elapsed = at - first.at;
    const delta = reading.progress - first.progress;
    const direction: Direction | null = delta > 0.08 ? 'to-current' : delta < -0.08 ? 'to-ssb' : null;
    const beganAtStop = distanceToNearestStop(first) <= 250;
    const speedMps = distanceMeters(first, reading) / Math.max(1, elapsed / 1000);
    if (beganAtStop && readings.length >= 4 && elapsed >= 15_000 && direction && speedMps >= 1.2 && speedMps <= 15) {
      sessionId = crypto.randomUUID();
      rideDirection = direction;
      sessionActivityAt = Date.now();
      sharingStatus && (sharingStatus.textContent = 'Likely shuttle ride detected. Sharing the estimated shuttle position.');
      setDestination(direction === 'to-current' ? 1 : 0, true);
      connectFeed();
      lastSentAt = 0;
    } else {
      sharingStatus && (sharingStatus.textContent = beganAtStop
        ? 'Waiting for sustained movement from a pickup point…'
        : 'Location is on. Waiting near SSB or The Current for shuttle movement…');
    }
  }

  if (sessionId) {
    latestReport = reading;
    sendReport(reading);
  }
}

function startSharing() {
  if (!navigator.geolocation) {
    sharingStatus && (sharingStatus.textContent = 'Location is unavailable in this browser.');
    return;
  }
  sharingButton && (sharingButton.textContent = 'Stop sharing');
  sharingStatus && (sharingStatus.textContent = 'Requesting location permission…');
  readings = [];
  connectFeed();
  locationWatch = navigator.geolocation.watchPosition(handleLocation, (error) => {
    if (error.code === error.PERMISSION_DENIED) stopSharing('Location permission was denied. You can still view shared ETAs.');
    else if (sharingStatus) sharingStatus.textContent = 'Waiting for location…';
  }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
}

sharingButton?.addEventListener('click', () => {
  if (locationWatch === undefined) startSharing();
  else stopSharing();
});
connectFeed();
setInterval(() => renderEstimate(lastEstimate), 15_000);

// Lisse (corne.rs) maintains continuous corners across viewport sizes.
document.querySelectorAll<HTMLElement>('[data-corner]').forEach((element) => {
  const update = () => {
    const { width, height } = element.getBoundingClientRect();
    if (!width || !height) return;
    element.style.clipPath = generateClipPath(width, height, {
      radius: Number(element.dataset.corner), smoothing: 0.6,
    });
  };
  update();
  observeResize(element, update);
});

void initializeMap().catch(() => {
  console.warn('Apple Maps unavailable; map was not loaded.');
});
