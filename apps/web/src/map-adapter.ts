import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapAdapter {
  setLocation: (location: { center?: [number, number]; bounds?: [[number, number], [number, number]]; zoom?: number; duration?: number }) => void;
  setStyle: (styleUrl: string) => void;
  getZoom: () => number;
  addMarker: (coordinates: [number, number], content: HTMLElement, options?: { anchor?: "center" | "bottom"; draggable?: boolean; onDragEnd?: (coordinates: [number, number]) => void }) => void;
  clearMarkers: () => void;
  destroy: () => void;
}

export function mapClickCoordinates(event: unknown): [number, number] | null {
  const point = event as { lngLat?: { lng?: unknown; lat?: unknown } } | null;
  const longitude = Number(point?.lngLat?.lng);
  const latitude = Number(point?.lngLat?.lat);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    return null;
  return [longitude, latitude];
}

export function createMapLibreAdapter(
  maplibre: typeof import("maplibre-gl"),
  container: HTMLElement,
  options: {
    center: [number, number];
    zoom: number;
    styleUrl: string;
    onViewport?: (bounds: MapBounds, zoom: number) => void;
    onClick?: (coordinates: [number, number] | null) => void;
    onLoad?: () => void;
    onError?: (message: string) => void;
  },
): MapAdapter {
  const map: MapLibreMap = new maplibre.Map({
    container,
    style: options.styleUrl,
    center: options.center,
    zoom: options.zoom,
    attributionControl: {},
    dragRotate: false,
    touchPitch: false,
  });
  const markers: MapLibreMarker[] = [];
  let didReportInitialViewport = false;

  map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
  map.once("load", () => options.onLoad?.());
  map.on("error", (event) => {
    if (!map.isStyleLoaded()) options.onError?.(event.error?.message ?? "Не удалось загрузить карту");
  });
  map.on("moveend", () => {
    const bounds = map.getBounds();
    if (!didReportInitialViewport) {
      didReportInitialViewport = true;
      return;
    }
    options.onViewport?.({
      west: Math.max(-180, bounds.getWest()),
      south: Math.max(-90, bounds.getSouth()),
      east: Math.min(180, bounds.getEast()),
      north: Math.min(90, bounds.getNorth()),
    }, map.getZoom());
  });
  map.on("click", (event) => options.onClick?.(mapClickCoordinates(event)));

  return {
    setLocation: (location) => {
      if (location.bounds) {
        map.fitBounds(location.bounds, { padding: 36, duration: location.duration ?? 0, maxZoom: 17 });
      } else if (location.center) {
        map.easeTo({
          center: location.center,
          zoom: location.zoom ?? map.getZoom(),
          duration: location.duration ?? 0,
        });
      }
    },
    setStyle: (styleUrl) => map.setStyle(styleUrl),
    getZoom: () => map.getZoom(),
    addMarker: (coordinates, content, markerOptions = {}) => {
      const marker = new maplibre.Marker({ element: content, anchor: markerOptions.anchor ?? "center", draggable: markerOptions.draggable ?? false })
        .setLngLat(coordinates)
        .addTo(map);
      if (markerOptions.onDragEnd) marker.on("dragend", () => {
        const point = marker.getLngLat();
        markerOptions.onDragEnd?.([point.lng, point.lat]);
      });
      markers.push(marker);
    },
    clearMarkers: () => {
      for (const marker of markers.splice(0)) marker.remove();
    },
    destroy: () => {
      for (const marker of markers.splice(0)) marker.remove();
      map.remove();
    },
  };
}
