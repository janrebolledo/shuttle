import { setRoutePath, stops, type Point } from '../shuttle';

let activeMap: mapkit.Map | undefined;
let shuttleMarker: mapkit.Annotation | undefined;
let shuttleMarkerElement: HTMLDivElement | undefined;
let shuttleSignalAvailable = true;
let userMarker: mapkit.MarkerAnnotation | undefined;
let routeOverlays: mapkit.PolylineOverlay[][] = [];
let routePaths: Point[][] = [];
let displayedOverlays: mapkit.PolylineOverlay[] = [];
let selectedDirection: 'to-current' | 'to-ssb' = 'to-current';
let userLocation: { latitude: number; longitude: number } | null = null;
let userOnShuttle = false;

function syncUserMarker() {
  if (!activeMap || !userLocation || userOnShuttle) {
    if (activeMap && userMarker) activeMap.removeAnnotation(userMarker);
    userMarker = undefined;
    return;
  }
  const coordinate = new mapkit.Coordinate(userLocation.latitude, userLocation.longitude);
  if (userMarker) userMarker.coordinate = coordinate;
  else {
    userMarker = new mapkit.MarkerAnnotation(coordinate, {
      title: 'Your location', color: '#3478f6', glyphText: '•', calloutEnabled: false,
    });
    activeMap.addAnnotation(userMarker);
  }
}

export function updateUserLocation(point: { latitude: number; longitude: number } | null, onShuttle = false) {
  userLocation = point;
  userOnShuttle = onShuttle;
  syncUserMarker();
}

export function updateShuttleMarker(point: { latitude: number; longitude: number } | null, signalAvailable = true) {
  shuttleSignalAvailable = signalAvailable;
  if (!activeMap || !point) {
    if (shuttleMarkerElement) shuttleMarkerElement.style.filter = signalAvailable ? '' : 'grayscale(1) opacity(0.5)';
    return;
  }
  const coordinate = new mapkit.Coordinate(point.latitude, point.longitude);
  if (shuttleMarker) shuttleMarker.coordinate = coordinate;
  else {
    shuttleMarker = new mapkit.Annotation(coordinate, () => {
      const marker = document.createElement('div');
      shuttleMarkerElement = marker;
      marker.textContent = '🚐';
      marker.dataset.corner = '12';
      Object.assign(marker.style, {
        width: '36px', height: '36px', display: 'grid', placeItems: 'center',
        boxSizing: 'border-box', border: '0.5px solid rgba(230, 227, 221, 0.5)',
        background: 'rgba(255, 255, 255, 0.92)',
        boxShadow: '0 2px 2px rgba(91, 79, 62, 0.25)', fontSize: '16px',
        filter: shuttleSignalAvailable ? '' : 'grayscale(1) opacity(0.5)',
      });
      return marker;
    }, {
      title: 'Shuttle', accessibilityLabel: 'Shuttle', size: { width: 36, height: 36 },
      anchorOffset: new DOMPoint(0, 18), calloutEnabled: false,
    });
    activeMap.addAnnotation(shuttleMarker);
  }
  if (shuttleMarkerElement) shuttleMarkerElement.style.filter = signalAvailable ? '' : 'grayscale(1) opacity(0.5)';
}

export function selectRoute(direction: 'to-current' | 'to-ssb') {
  selectedDirection = direction;
  const index = direction === 'to-current' ? 0 : 1;
  if (!activeMap || !routePaths[index]) return;
  for (const overlay of displayedOverlays) activeMap.removeOverlay(overlay);
  setRoutePath(routePaths[index]!);
  displayedOverlays = [];
  for (const groupIndex of [1 - index, index]) {
    for (const overlay of routeOverlays[groupIndex]!) {
      const selected = groupIndex === index;
      overlay.style.strokeColor = selected ? '#3478f6' : '#a9c9ff';
      overlay.style.strokeOpacity = selected ? 0.95 : 0.72;
      overlay.style.lineWidth = selected ? 6 : 5;
      activeMap.addOverlay(overlay);
      displayedOverlays.push(overlay);
    }
  }
}

export async function initializeMap() {
  const response = await fetch('/api/mapkit-token');
  if (!response.ok) throw new Error('Map configuration unavailable');
  const { token } = await response.json() as { token: string | null };
  if (!token) return;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.apple-mapkit.com/mk/6/mapkit.core.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('MapKit could not load'));
    document.head.appendChild(script);
  });

  mapkit.init({ authorizationCallback: (done) => done(token), language: 'en' });
  const mapkit6 = mapkit as typeof mapkit & {
    load: (libraries: string[]) => Promise<typeof mapkit>;
  };
  await mapkit6.load(['full-map', 'services']);
  const container = document.querySelector<HTMLElement>('#map')!;
  container.hidden = false;
  const section = container.parentElement!;
  // Reveal the map before constructing it so MapKit measures a visible canvas.
  section.classList.add('is-live');
  try {
    const initialRegion = new mapkit.CoordinateRegion(
      new mapkit.Coordinate(34.0615, -117.811),
      new mapkit.CoordinateSpan(0.018, 0.023),
    );
    activeMap = new mapkit.Map(container, {
      region: initialRegion,
      padding: new mapkit.Padding(0, 0, 540, 0),
      isScrollEnabled: true,
      isZoomEnabled: true,
      showsMapTypeControl: false,
      showsZoomControl: false,
      isRotationEnabled: false,
      colorScheme: (mapkit as typeof mapkit & {
        ColorScheme: { Light: string };
      }).ColorScheme.Light,
    });
    const initialCameraDistance = activeMap.cameraDistance;
    activeMap.setCameraBoundaryAnimated(initialRegion, false);
    activeMap.cameraZoomRange = new mapkit.CameraZoomRange(
      initialCameraDistance / 10,
      initialCameraDistance,
    );
  const directions = new mapkit.Directions();
  const automobile = (mapkit as typeof mapkit & {
    TransportType: { Automobile: mapkit.Directions.Transport };
  }).TransportType.Automobile;
  const routeBetween = (origin: Point, destination: Point) => new Promise<mapkit.Route | undefined>((resolve) => {
      directions.route({
        origin: new mapkit.Coordinate(origin.latitude, origin.longitude),
        destination: new mapkit.Coordinate(destination.latitude, destination.longitude),
        transportType: automobile,
      }, (error, response) => resolve(error ? undefined : response.routes[0]));
    });
    let requestId = 0;
    const rebuildRoutes = () => {
      const id = ++requestId;
      const toCurrentLegs = [[stops.ssb, stops.current]];
      const toCppLegs = [[stops.current, stops.ssb]];
      void Promise.all([
        Promise.all(toCurrentLegs.map(([origin, destination]) => routeBetween(origin!, destination!))),
        Promise.all(toCppLegs.map(([origin, destination]) => routeBetween(origin!, destination!))),
      ]).then(([toCurrent, toCpp]) => {
        if (id !== requestId || !activeMap || toCurrent.some((route) => !route) || toCpp.some((route) => !route)) return;
        for (const overlay of displayedOverlays) activeMap.removeOverlay(overlay);
        displayedOverlays = [];
        const currentRoutes = toCurrent as mapkit.Route[];
        const cppRoutes = toCpp as mapkit.Route[];
        const compactPath = (routes: mapkit.Route[], reverse = false) => {
          const points = routes.flatMap((route, index) => route.polyline.points.slice(index ? 1 : 0));
          const stride = Math.max(1, Math.ceil((points.length - 1) / 79));
          const compact = points.filter((_, index) => index % stride === 0 || index === points.length - 1)
            .map(({ latitude, longitude }): Point => ({ latitude, longitude }));
          return reverse ? compact.reverse() : compact;
        };
        routeOverlays = [currentRoutes, cppRoutes].map((routes) => routes.map(({ polyline }) => polyline));
        routePaths = [compactPath(currentRoutes), compactPath(cppRoutes, true)];
        for (const overlays of routeOverlays) for (const overlay of overlays) {
          overlay.style.lineCap = 'round';
          overlay.style.lineJoin = 'round';
        }
        selectRoute(selectedDirection);
      });
    };
    rebuildRoutes();
  } catch (error) {
    section.classList.remove('is-live');
    throw error;
  }
  syncUserMarker();
  // Keep Apple's attribution unobscured below the shared shuttle marker.
}
