let activeMap: mapkit.Map | undefined;
let shuttleMarker: mapkit.MarkerAnnotation | undefined;
let userMarker: mapkit.MarkerAnnotation | undefined;
let userLocation: { latitude: number; longitude: number } | null = null;

function syncUserMarker() {
  if (!activeMap || !userLocation) {
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

export function updateUserLocation(point: { latitude: number; longitude: number } | null) {
  userLocation = point;
  syncUserMarker();
}

export function updateShuttleMarker(point: { latitude: number; longitude: number } | null) {
  if (!activeMap || !point) {
    if (activeMap && shuttleMarker) activeMap.removeAnnotation(shuttleMarker);
    shuttleMarker = undefined;
    return;
  }
  const coordinate = new mapkit.Coordinate(point.latitude, point.longitude);
  if (shuttleMarker) shuttleMarker.coordinate = coordinate;
  else {
    shuttleMarker = new mapkit.MarkerAnnotation(coordinate, {
      title: 'Shuttle', color: '#3478f6', glyphText: 'S', calloutEnabled: false,
    });
    activeMap.addAnnotation(shuttleMarker);
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
  await mapkit6.load(['full-map']);
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
  } catch (error) {
    section.classList.remove('is-live');
    throw error;
  }
  syncUserMarker();
  // Keep Apple's attribution unobscured below the shared shuttle marker.
}
