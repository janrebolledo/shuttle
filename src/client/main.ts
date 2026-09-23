import { animate } from 'motion/mini';
import { generateClipPath, observeResize } from '@lisse/core';
import { initializeMap, updateShuttleMarker, updateUserLocation } from './map';
import { MAX_ACCURACY_METERS, ROUTE_WIDTH_METERS, distanceMeters, routePosition, scheduleFallback, stops, type Direction, type Point } from '../shuttle';
import './alert-sheet';
import './location-consent';

const destinationHeading = document.querySelector<HTMLHeadingElement>('#destination');
const destinationButton = document.querySelector<HTMLButtonElement>('.page-indicator');
const destinationDots = destinationButton?.querySelectorAll<HTMLElement>('i');
const arrivals = document.querySelector<HTMLElement>('.arrivals');
const arrivalCarousel = document.querySelector<HTMLElement>('.arrival-carousel');
const sheetHandle = document.querySelector<HTMLButtonElement>('.sheet-handle');
const mapSection = document.querySelector<HTMLElement>('.map-section');
const sharingButton = document.querySelector<HTMLButtonElement>('#sharing-button');
const sharingStatus = document.querySelector<HTMLElement>('#sharing-status');
const destinations = ['the current', 'cal poly pomona'];
let destinationIndex = 0;
let routeChosenManually = false;

function setSheetExpanded(expanded: boolean) {
  arrivals?.classList.toggle('is-expanded', expanded);
  sheetHandle?.setAttribute('aria-expanded', String(expanded));
  sheetHandle?.setAttribute('aria-label', expanded ? 'Collapse arrivals' : 'Expand arrivals');
}

sheetHandle?.addEventListener('click', (event) => {
  if (sheetHandle.dataset.dragged === 'true') {
    event.preventDefault();
    sheetHandle.dataset.dragged = 'false';
    return;
  }
  setSheetExpanded(!arrivals?.classList.contains('is-expanded'));
});

let sheetDrag: { y: number; height: number; pointerId: number; moved: boolean } | undefined;
sheetHandle?.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary) return;
  sheetDrag = { y: event.clientY, height: arrivals?.getBoundingClientRect().height ?? 0, pointerId: event.pointerId, moved: false };
  sheetHandle.setPointerCapture(event.pointerId);
  if (arrivals) arrivals.style.transition = 'none';
});
sheetHandle?.addEventListener('pointermove', (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId || !arrivals) return;
  const delta = sheetDrag.y - event.clientY;
  if (Math.abs(delta) > 6) sheetDrag.moved = true;
  if (sheetDrag.moved) {
    const maxHeight = window.innerHeight - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top'));
    arrivals.style.height = `${Math.max(260, Math.min(maxHeight, sheetDrag.height + delta))}px`;
  }
});
function finishSheetDrag(event: PointerEvent) {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId || !arrivals) return;
  const dragged = sheetDrag.moved;
  const currentHeight = arrivals.getBoundingClientRect().height;
  const maxHeight = window.innerHeight - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top'));
  const compactHeight = Math.min(window.innerHeight * (window.innerHeight >= 900 ? 0.58 : 0.62), window.innerHeight >= 900 ? 600 : 560);
  sheetDrag = undefined;
  arrivals.style.transition = '';
  arrivals.style.height = '';
  if (dragged) {
    if (sheetHandle) sheetHandle.dataset.dragged = 'true';
    setSheetExpanded(currentHeight > (compactHeight + maxHeight) / 2);
    setTimeout(() => { if (sheetHandle) sheetHandle.dataset.dragged = 'false'; }, 0);
  }
}
sheetHandle?.addEventListener('pointerup', finishSheetDrag);
sheetHandle?.addEventListener('pointercancel', finishSheetDrag);

function setDestination(index: number, automatic = false) {
  if (!automatic) routeChosenManually = true;
  const heading = destinationHeading;
  const destination = destinations[index];
  if (!heading || !destinationButton || !destinationDots || !destination || index === destinationIndex) return;

  destinationIndex = index;
  heading.textContent = destination;
  renderEstimate(lastEstimate);
  arrivalCarousel?.scrollTo({ left: index * arrivalCarousel.clientWidth, behavior: 'smooth' });
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

let arrivalScrollTimer: ReturnType<typeof setTimeout> | undefined;
function syncDestinationFromCarousel() {
  if (!arrivalCarousel?.clientWidth) return;
  const index = Math.round(arrivalCarousel.scrollLeft / arrivalCarousel.clientWidth);
  if (index !== destinationIndex) setDestination(index);
}
arrivalCarousel?.addEventListener('scroll', () => {
  if (arrivalScrollTimer) clearTimeout(arrivalScrollTimer);
  arrivalScrollTimer = setTimeout(syncDestinationFromCarousel, 300);
}, { passive: true });
arrivalCarousel?.addEventListener('scrollend', () => {
  if (arrivalScrollTimer) clearTimeout(arrivalScrollTimer);
  syncDestinationFromCarousel();
});

function enableRouteSwipe(surface: HTMLElement | null, capture = false) {
  let swipeStart: { x: number; y: number; pointerId: number; target: EventTarget | null } | undefined;
  surface?.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest('.arrival-carousel, #map, button, a, input')) return;
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
let locationWaitTimer: ReturnType<typeof setTimeout> | undefined;
let permissionStatus: PermissionStatus | undefined;
let hasLocationFix = false;
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
  const unavailable = !estimate || Date.now() - estimate.updatedAt > 75_000;
  document.querySelectorAll<HTMLElement>('.arrival-route').forEach((route, index) => {
    const nextRange = route.querySelector<HTMLElement>('[data-estimate="next-range"]');
    const nextDetail = route.querySelector<HTMLElement>('[data-estimate="next-detail"]');
    const followingRange = route.querySelector<HTMLElement>('[data-estimate="following-range"]');
    const followingDetail = route.querySelector<HTMLElement>('[data-estimate="following-detail"]');
    route.querySelector<HTMLElement>('[data-estimate="signal"]')?.classList.toggle('is-unavailable', unavailable);
    if (unavailable) {
      const fallback = scheduleFallback();
      const onThisLeg = sessionId && rideDirection === (index === 0 ? 'to-current' : 'to-ssb');
      nextRange && (nextRange.textContent = onThisLeg ? 'on shuttle' : '—');
      nextDetail && (nextDetail.textContent = onThisLeg ? 'You’re riding this shuttle.' : 'Live ETA unavailable');
      followingRange && (followingRange.textContent = fallback.minutes === undefined ? '—' : `${fallback.minutes} min`);
      followingDetail && (followingDetail.textContent = fallback.time
        ? `Scheduled ${fallback.time}`
        : fallback.status);
      return;
    }
    const routeArrivals = estimate.arrivals[index === 0 ? 'current' : 'ssb'];
    const onThisLeg = sessionId && rideDirection === (index === 0 ? 'to-current' : 'to-ssb');
    nextRange && (nextRange.textContent = onThisLeg ? 'on shuttle' : formatRange(routeArrivals.next));
    const ageSeconds = Math.max(0, Math.floor((Date.now() - estimate.updatedAt) / 1000));
    nextDetail && (nextDetail.textContent = onThisLeg
      ? 'You’re riding this shuttle.'
      : `Estimated · updated ${ageSeconds < 10 ? 'just now' : `${ageSeconds}s ago`}`);
    followingRange && (followingRange.textContent = formatRange(routeArrivals.following));
    followingDetail && (followingDetail.textContent = 'Next circuit · estimate');
  });
  if (unavailable) {
    updateShuttleMarker(null);
    return;
  }
  updateShuttleMarker(estimate);
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
  localStorage.setItem('shuttle-location-consent', 'declined');
  if (locationWatch !== undefined) navigator.geolocation?.clearWatch(locationWatch);
  if (locationWaitTimer !== undefined) clearTimeout(locationWaitTimer);
  if (permissionStatus) permissionStatus.onchange = null;
  locationWatch = undefined;
  locationWaitTimer = undefined;
  permissionStatus = undefined;
  hasLocationFix = false;
  if (sessionId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
  updateUserLocation(null);
  sessionId = undefined;
  rideDirection = undefined;
  sessionActivityAt = 0;
  latestReport = undefined;
  readings = [];
  renderEstimate(lastEstimate);
  sharingButton && (sharingButton.textContent = 'Enable location for shared ETAs');
  sharingStatus && (sharingStatus.textContent = status);
  window.dispatchEvent(new CustomEvent('shuttle-location-sharing-change', { detail: false }));
}

function distanceToNearestStop(point: Point) {
  return Math.min(distanceMeters(point, stops.ssb), distanceMeters(point, stops.current));
}

function handleLocation(position: GeolocationPosition) {
  hasLocationFix = true;
  if (locationWaitTimer !== undefined) clearTimeout(locationWaitTimer);
  locationWaitTimer = undefined;
  if (sessionId && Date.now() - sessionActivityAt > 75_000) {
    socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'stop' }));
    sessionId = undefined;
    rideDirection = undefined;
    sessionActivityAt = 0;
    latestReport = undefined;
    readings = [];
    renderEstimate(lastEstimate);
  }
  const { latitude, longitude, accuracy, speed } = position.coords;
  const point = { latitude, longitude };
  updateUserLocation(point);
  if (accuracy > MAX_ACCURACY_METERS) {
    if (sharingStatus) sharingStatus.textContent = 'Location is on. Waiting for a more accurate reading…';
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
      renderEstimate(lastEstimate);
    }
    sharingStatus && (sharingStatus.textContent = 'Location is outside the shuttle corridor. Sharing is on; waiting near SSB or The Current.');
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
    setDestination(distanceMeters(point, stops.current) < distanceMeters(point, stops.ssb) ? 1 : 0, true);
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
      renderEstimate(lastEstimate);
      setDestination(direction === 'to-current' ? 0 : 1, true);
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
  localStorage.setItem('shuttle-location-consent', 'allowed');
  sharingButton && (sharingButton.textContent = 'Stop sharing');
  sharingStatus && (sharingStatus.textContent = 'Waiting for your browser’s location permission…');
  hasLocationFix = false;
  readings = [];
  connectFeed();
  locationWatch = navigator.geolocation.watchPosition(handleLocation, (error) => {
    if (error.code === error.PERMISSION_DENIED) stopSharing('Location permission was denied. You can still view shared ETAs.');
    else if (sharingStatus) sharingStatus.textContent = 'Your device hasn’t provided a location yet. Check browser and device location settings.';
  }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
  window.dispatchEvent(new CustomEvent('shuttle-location-sharing-change', { detail: true }));
  locationWaitTimer = setTimeout(() => {
    if (!hasLocationFix && sharingStatus) sharingStatus.textContent = 'Still waiting for a location fix. Check browser permission and device Location Services.';
  }, 15_000);
  void navigator.permissions?.query({ name: 'geolocation' }).then((status) => {
    if (locationWatch === undefined) return;
    permissionStatus = status;
    const updatePermission = () => {
      if (locationWatch === undefined) return;
      if (status.state === 'denied') {
        stopSharing('Location permission was denied. You can still view shared ETAs.');
      } else if (status.state === 'prompt' && !hasLocationFix) {
        sharingStatus && (sharingStatus.textContent = 'Allow location in your browser prompt to continue.');
      } else if (!hasLocationFix) {
        sharingStatus && (sharingStatus.textContent = 'Location permission is allowed. Waiting for a device location fix…');
      }
    };
    status.onchange = updatePermission;
    updatePermission();
  }).catch(() => {
    // Some browsers do not expose geolocation permission state; watchPosition still reports fixes/errors.
  });
}

window.addEventListener('shuttle-location-consent', startSharing);
window.addEventListener('shuttle-location-stop', () => stopSharing());

if (localStorage.getItem('shuttle-location-consent') === 'allowed') startSharing();

sharingButton?.addEventListener('click', () => {
  if (locationWatch === undefined) startSharing();
  else stopSharing();
});
renderEstimate(null);
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

void initializeMap().catch((error) => {
  console.warn('Apple Maps unavailable; map was not loaded.', error);
});
