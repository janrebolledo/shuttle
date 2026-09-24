import { generateClipPath, observeResize } from '@lisse/core';
import { initializeMap, selectRoute, updateShuttleMarker, updateUserLocation } from './map';
import { MAX_ACCURACY_METERS, ROUTE_WIDTH_METERS, distanceMeters, etaRange, getRoutePath, pointAtRouteProgress, routeLength, routePosition, scheduleFallback, stops, type Direction, type Point } from '../shuttle';
import './alert-sheet';
import './location-consent';

const destinationButton = document.querySelector<HTMLButtonElement>('.page-indicator');
const destinationDots = destinationButton?.querySelectorAll<HTMLElement>('i');
const arrivals = document.querySelector<HTMLElement>('.arrivals');
const arrivalCarousel = document.querySelector<HTMLElement>('.arrival-carousel');
const sheetHandle = document.querySelector<HTMLButtonElement>('.sheet-handle');
const mapSection = document.querySelector<HTMLElement>('.map-section');
const campusSwitcher = document.querySelector<HTMLButtonElement>('#campus-switcher');
const campusMenu = document.querySelector<HTMLElement>('#campus-menu');
const sharingButton = document.querySelector<HTMLButtonElement>('#sharing-button');
const sharingStatus = document.querySelector<HTMLElement>('#sharing-status');
const destinations = ['the current', 'cal poly pomona'];
let destinationIndex = 0;
let destinationScrollTarget: number | undefined;
let routeChosenManually = false;

function setCampusMenuOpen(open: boolean) {
  if (!campusSwitcher || !campusMenu) return;
  campusMenu.hidden = !open;
  campusSwitcher.setAttribute('aria-expanded', String(open));
  if (open) campusMenu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
}

campusSwitcher?.addEventListener('click', () => {
  setCampusMenuOpen(campusMenu?.hidden ?? true);
});
campusMenu?.addEventListener('click', (event) => {
  if ((event.target as Element).closest('[data-campus-option]')) {
    setCampusMenuOpen(false);
    campusSwitcher?.focus({ preventScroll: true });
  }
});
campusMenu?.addEventListener('keydown', (event) => {
  const options = [...campusMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = options.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1;
  if (next >= 0) {
    event.preventDefault();
    options[(next + options.length) % options.length]?.focus();
  } else if (event.key === 'Escape') {
    setCampusMenuOpen(false);
    campusSwitcher?.focus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!campusMenu?.hidden && !(event.target as Element | null)?.closest('#campus-switcher, #campus-menu')) setCampusMenuOpen(false);
});

function setSheetExpanded(expanded: boolean) {
  arrivals?.classList.toggle('is-expanded', expanded);
  if (arrivals) arrivals.dataset.corner = expanded ? '0 0 0 0' : '28 28 0 0';
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

function setDestination(index: number, automatic = false, scroll = true) {
  if (!automatic) routeChosenManually = true;
  const destination = destinations[index];
  if (!destinationButton || !destinationDots || !destination || index === destinationIndex) return;

  destinationIndex = index;
  selectRoute(index === 0 ? 'to-current' : 'to-ssb');
  renderEstimate(lastEstimate);
  if (scroll && arrivalCarousel) {
    destinationScrollTarget = index;
    arrivalCarousel.scrollTo({
      left: index * arrivalCarousel.clientWidth,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
  destinationButton.setAttribute('aria-label', `Change destination, currently ${index + 1} of 2: ${destination}`);
  destinationDots.forEach((dot, dotIndex) => dot.classList.toggle('is-active', dotIndex === index));
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

function syncDestinationFromCarousel() {
  if (!arrivalCarousel?.clientWidth) return;
  const index = Math.round(arrivalCarousel.scrollLeft / arrivalCarousel.clientWidth);
  if (destinationScrollTarget !== undefined) {
    if (index !== destinationScrollTarget) return;
    destinationScrollTarget = undefined;
  }
  if (index !== destinationIndex) setDestination(index, false, false);
}
arrivalCarousel?.addEventListener('scroll', syncDestinationFromCarousel, { passive: true });
arrivalCarousel?.addEventListener('scrollend', () => {
  destinationScrollTarget = undefined;
  syncDestinationFromCarousel();
});
arrivalCarousel?.addEventListener('pointerdown', () => { destinationScrollTarget = undefined; }, { passive: true });
arrivalCarousel?.addEventListener('wheel', () => { destinationScrollTarget = undefined; }, { passive: true });
arrivalCarousel?.addEventListener('keydown', () => { destinationScrollTarget = undefined; });

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
let debugSimulation: 'waiting' | 'waiting-current' | Direction | null = null;
let resumeLocationAfterDebug = false;
let debugProgress = 0.5;
let debugPlaybackTimer: ReturnType<typeof setInterval> | undefined;

function formatRange(range: { min: number; max: number }) {
  return range.min === range.max ? `${range.min} min` : `${range.min}–${range.max} min`;
}

function formatEta(range: { min: number; max: number }) {
  const minutes = Math.round((range.min + range.max) / 2);
  return `${new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' })} ETA`;
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
    nextDetail && (nextDetail.textContent = onThisLeg
      ? 'You’re riding this shuttle.'
      : formatEta(routeArrivals.next));
    followingRange && (followingRange.textContent = formatRange(routeArrivals.following));
    followingDetail && (followingDetail.textContent = 'Next circuit · estimate');
  });
  if (unavailable) {
    updateShuttleMarker(null, false);
    return;
  }
  updateShuttleMarker(estimate);
}

function setupLocationDebug() {
  if (!['localhost', '127.0.0.1', '::1'].includes(location.hostname) && !new URLSearchParams(location.search).has('debug')) return;
  const toggle = document.createElement('button');
  toggle.className = 'location-debug-toggle';
  toggle.dataset.corner = '22';
  toggle.type = 'button';
  toggle.textContent = 'Debug';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'location-debug-panel');
  const panel = document.createElement('section');
  panel.className = 'location-debug-panel';
  panel.dataset.corner = '18';
  panel.id = 'location-debug-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Location simulation');
  panel.innerHTML = '<strong>Simulate location</strong><button type="button" data-corner="10" data-simulate="waiting">Waiting at SSB</button><button type="button" data-corner="10" data-simulate="waiting-current">Waiting at The Current</button><button type="button" data-corner="10" data-simulate="to-current">On route to The Current</button><button type="button" data-corner="10" data-simulate="to-ssb">On route to Cal Poly Pomona</button><button type="button" data-corner="10" data-simulate="play-pause" hidden>Play simulation</button><button type="button" data-corner="10" data-simulate="off">Use device location</button>';
  document.body.appendChild(toggle);
  document.body.appendChild(panel);
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  panel.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-simulate]');
    if (!button) return;
    const mode = button.dataset.simulate;
    if (mode === 'play-pause') {
      if (debugPlaybackTimer) {
        clearInterval(debugPlaybackTimer);
        debugPlaybackTimer = undefined;
        button.textContent = 'Play simulation';
      } else if (debugSimulation === 'to-current' || debugSimulation === 'to-ssb') {
        const direction = debugSimulation;
        if (debugProgress === (direction === 'to-current' ? 1 : 0)) debugProgress = direction === 'to-current' ? 0 : 1;
        button.textContent = 'Pause simulation';
        const routeLengthMeters = routeLength();
        debugPlaybackTimer = setInterval(() => {
          debugProgress = Math.max(0, Math.min(1, debugProgress + (direction === 'to-current' ? 1 : -1) * 8 / routeLengthMeters));
          const point = pointAtRouteProgress(debugProgress);
          updateUserLocation(point, true);
          const arrivals = {
            ssb: etaRange(point, direction, 'ssb', 8),
            current: etaRange(point, direction, 'current', 8),
          };
          renderEstimate({ ...point, direction, updatedAt: Date.now(), contributors: 1, arrivals });
          latestReport = makeDebugReading(point);
          sendReport(latestReport);
          if (debugProgress === (direction === 'to-current' ? 1 : 0)) {
            clearInterval(debugPlaybackTimer);
            debugPlaybackTimer = undefined;
            button.textContent = 'Play simulation';
          }
        }, 1_000);
      }
      return;
    }
    if (mode === 'off') {
      if (debugPlaybackTimer) clearInterval(debugPlaybackTimer);
      debugPlaybackTimer = undefined;
      if (sessionId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
      const resume = resumeLocationAfterDebug;
      debugSimulation = null;
      resumeLocationAfterDebug = false;
      sessionId = undefined;
      rideDirection = undefined;
      latestReport = undefined;
      readings = [];
      updateUserLocation(null);
      renderEstimate(null);
      panel.querySelector<HTMLButtonElement>('[data-simulate="play-pause"]')!.hidden = true;
      sharingStatus && (sharingStatus.textContent = 'Location simulation is off.');
      if (resume) startSharing();
      return;
    }
    if (!debugSimulation) {
      resumeLocationAfterDebug = locationWatch !== undefined;
      if (locationWatch !== undefined) navigator.geolocation.clearWatch(locationWatch);
      if (locationWaitTimer !== undefined) clearTimeout(locationWaitTimer);
      locationWatch = undefined;
      locationWaitTimer = undefined;
    }
    debugSimulation = mode as 'waiting' | 'waiting-current' | Direction;
    if (debugPlaybackTimer) clearInterval(debugPlaybackTimer);
    debugPlaybackTimer = undefined;
    const playback = panel.querySelector<HTMLButtonElement>('[data-simulate="play-pause"]')!;
    const waiting = debugSimulation === 'waiting' || debugSimulation === 'waiting-current';
    playback.hidden = waiting;
    playback.textContent = 'Play simulation';
    readings = [];
    latestReport = undefined;
    if (waiting) debugProgress = mode === 'waiting-current' ? 1 : 0;
    else {
      const direction = mode as Direction;
      setDestination(direction === 'to-current' ? 0 : 1, true);
      debugProgress = direction === 'to-current' ? 0 : 1;
    }
    const point = waiting ? (mode === 'waiting-current' ? stops.current : stops.ssb) : pointAtRouteProgress(debugProgress);
    updateUserLocation(point);
    if (waiting) {
      if (sessionId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
      sessionId = undefined;
      rideDirection = undefined;
      latestReport = undefined;
      renderEstimate(null);
      sharingStatus && (sharingStatus.textContent = mode === 'waiting-current'
        ? 'Simulating a user waiting at The Current.'
        : 'Simulating a user waiting at SSB.');
    } else {
      const direction = mode as Direction;
      if (sessionId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
      sessionId = crypto.randomUUID();
      rideDirection = direction;
      updateUserLocation(point, true);
      const routeEstimate = etaRange(point, direction, 'ssb', 7);
      const currentEstimate = etaRange(point, direction, 'current', 7);
      renderEstimate({ ...point, direction, updatedAt: Date.now(), contributors: 1, arrivals: { ssb: routeEstimate, current: currentEstimate } });
      latestReport = makeDebugReading(point);
      lastSentAt = 0;
      connectFeed();
      sendReport(latestReport);
      sharingStatus && (sharingStatus.textContent = `Simulating a user on route to ${direction === 'to-current' ? 'The Current' : 'Cal Poly Pomona'}.`);
    }
  });
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
    accuracy: reading.accuracy, direction, speedMps: reading.speedMps, routePath: getRoutePath(),
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

function makeDebugReading(point: Point): LocationReading {
  return { ...point, accuracy: 5, at: Date.now(), progress: routePosition(point).progress, speedMps: 8 };
}

function handleLocation(position: GeolocationPosition) {
  if (debugSimulation) return;
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
  updateUserLocation(point, Boolean(sessionId));
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
      updateUserLocation(point);
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
      updateUserLocation(point, true);
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
setupLocationDebug();
connectFeed();
setInterval(() => renderEstimate(lastEstimate), 15_000);

// Shape only the surface so Lisse never crops icons, text, or controls.
const lisseCornerUpdates = new WeakMap<HTMLElement, () => void>();
function applyLisseCorner(element: HTMLElement) {
  let update = lisseCornerUpdates.get(element);
  if (!update) {
    const direct = element.hasAttribute('data-lisse-direct');
    const surface = direct ? undefined : document.createElement('div');
    if (surface) {
      surface.className = 'lisse-surface';
      surface.setAttribute('aria-hidden', 'true');
      element.insertBefore(surface, element.firstChild);
    }
    const original = {
      background: element.style.background,
      borderColor: element.style.borderColor,
      boxShadow: element.style.boxShadow,
      backdropFilter: element.style.backdropFilter,
      webkitBackdropFilter: element.style.getPropertyValue('-webkit-backdrop-filter'),
    };
    const restore = () => {
      element.style.background = original.background;
      element.style.borderColor = original.borderColor;
      element.style.boxShadow = original.boxShadow;
      element.style.backdropFilter = original.backdropFilter;
      if (original.webkitBackdropFilter) element.style.setProperty('-webkit-backdrop-filter', original.webkitBackdropFilter);
      else element.style.removeProperty('-webkit-backdrop-filter');
    };
    update = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const values = element.dataset.corner?.trim().split(/\s+/) ?? [];
      const radius = (value: string | undefined) => value === 'round' ? Math.min(width, height) / 2 : Number(value ?? 0);
      const smoothing = 0.6;
      const path = values.length === 4
        ? generateClipPath(width, height, {
          topLeft: { radius: radius(values[0]), smoothing },
          topRight: { radius: radius(values[1]), smoothing },
          bottomRight: { radius: radius(values[2]), smoothing },
          bottomLeft: { radius: radius(values[3]), smoothing },
        })
        : generateClipPath(width, height, { radius: radius(values[0]), smoothing });
      restore();
      const style = getComputedStyle(element);
      if (direct) {
        element.style.clipPath = path;
        return;
      }
      if (!surface) return;
      surface.style.inset = `${-parseFloat(style.borderTopWidth)}px ${-parseFloat(style.borderRightWidth)}px ${-parseFloat(style.borderBottomWidth)}px ${-parseFloat(style.borderLeftWidth)}px`;
      surface.style.background = style.background;
      surface.style.border = style.border;
      surface.style.boxShadow = style.boxShadow;
      surface.style.backdropFilter = style.backdropFilter;
      surface.style.setProperty('-webkit-backdrop-filter', style.getPropertyValue('-webkit-backdrop-filter'));
      surface.style.clipPath = path;
      element.style.background = 'transparent';
      element.style.borderColor = 'transparent';
      element.style.boxShadow = 'none';
      element.style.backdropFilter = 'none';
      element.style.setProperty('-webkit-backdrop-filter', 'none');
    };
    if (!direct) {
      const computedPosition = getComputedStyle(element).position;
      if (computedPosition === 'static') element.style.position = 'relative';
      element.style.isolation = 'isolate';
    }
    lisseCornerUpdates.set(element, update);
    observeResize(element, update);
  }
  update();
}
function scanLisseCorners(node: Node) {
  if (!(node instanceof HTMLElement)) return;
  if (node.hasAttribute('data-corner')) applyLisseCorner(node);
  node.querySelectorAll<HTMLElement>('[data-corner]').forEach(applyLisseCorner);
}
document.querySelectorAll<HTMLElement>('[data-corner]').forEach(applyLisseCorner);
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'attributes') applyLisseCorner(record.target as HTMLElement);
    else record.addedNodes.forEach(scanLisseCorners);
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-corner', 'class', 'aria-checked'], childList: true, subtree: true });

void initializeMap().catch((error) => {
  console.warn('Apple Maps unavailable; map was not loaded.', error);
});
