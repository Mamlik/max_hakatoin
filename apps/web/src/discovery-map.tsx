import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useColorMode } from "./theme";
import type { DiscoverySalon, MapCluster } from "./types";
import { createMapLibreAdapter, type MapAdapter, type MapBounds } from "./map-adapter";

export const DEFAULT_MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/fiord",
};

type MapStyles = { light?: string; dark?: string };
type MapLibreModule = typeof import("maplibre-gl");
let mapLibrePromise: Promise<MapLibreModule> | undefined;

function loadMapLibre(): Promise<MapLibreModule> {
  if (!mapLibrePromise) {
    mapLibrePromise = Promise.all([
      import("maplibre-gl"),
      import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
      import("maplibre-gl/dist/maplibre-gl.css"),
    ]).then(([maplibre, worker]) => {
      maplibre.setWorkerUrl(worker.default);
      return maplibre;
    }).catch((cause: unknown) => {
      mapLibrePromise = undefined;
      throw cause;
    });
  }
  return mapLibrePromise;
}

function mapStyle(styles: MapStyles, mode: "light" | "dark") {
  return mode === "dark"
    ? styles.dark || DEFAULT_MAP_STYLES.dark
    : styles.light || DEFAULT_MAP_STYLES.light;
}

const EMPTY_MAP_CLUSTERS: MapCluster[] = [];

function makeClusters(items: DiscoverySalon[], zoom: number) {
  // Keep the cluster radius in screen pixels instead of using a coarse,
  // zoom-bucketed degree grid. This makes groups split as soon as their
  // members are visually far enough apart at the current zoom.
  const latitude = items.find((item) => item.location)?.location?.latitude ?? 55.75;
  const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom;
  // Keep a fixed screen-space separation. At country-level zoom this grows
  // naturally to city-sized radii, while close zooms still split nearby salons.
  const radiusMeters = Math.max(38, metersPerPixel * 56);
  const latCell = radiusMeters / 111_320;
  const lonCell = radiusMeters / (111_320 * Math.max(0.2, Math.cos(latitude * Math.PI / 180)));
  const groups = new Map<string, DiscoverySalon[]>();
  for (const salon of items) {
    if (!salon.location) continue;
    const key = `${Math.floor(salon.location.longitude / lonCell)}:${Math.floor(salon.location.latitude / latCell)}`;
    groups.set(key, [...(groups.get(key) ?? []), salon]);
  }
  return [...groups.values()].map((salons) => ({
    salons,
    center: [
      salons.reduce((sum, salon) => sum + salon.location!.longitude, 0) / salons.length,
      salons.reduce((sum, salon) => sum + salon.location!.latitude, 0) / salons.length,
    ] as [number, number],
  }));
}

export function DiscoveryMap({
  items,
  clusters,
  selectedId,
  userLocation,
  styles = DEFAULT_MAP_STYLES,
  onSelect,
  onViewport,
  onPickCoordinates,
}: {
  items: DiscoverySalon[];
  clusters?: MapCluster[];
  selectedId?: string;
  userLocation?: { latitude: number; longitude: number } | null;
  styles?: MapStyles;
  onSelect?: (salon: DiscoverySalon) => void;
  onViewport?: (bounds: MapBounds, zoom: number) => void;
  onPickCoordinates?: (latitude: number, longitude: number) => void;
}) {
  const { resolvedMode } = useColorMode();
  const styleUrl = mapStyle(styles, resolvedMode);
  const clusterItems = clusters ?? EMPTY_MAP_CLUSTERS;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapAdapter | null>(null);
  const didFit = useRef(false);
  const handlers = useRef({ onSelect, onViewport, onPickCoordinates });
  const itemsRef = useRef(items);
  const styleUrlRef = useRef(styleUrl);
  const appliedStyleUrl = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const ignoreViewportUntil = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(11);
  const localClusters = useMemo(() => makeClusters(items, zoom), [items, zoom]);
  const selectedLocation = selectedId
    ? items.find((salon) => salon.id === selectedId)?.location
    : null;
  handlers.current = { onSelect, onViewport, onPickCoordinates };
  itemsRef.current = items;
  styleUrlRef.current = styleUrl;
  const setCameraSilently = (location: Parameters<MapAdapter["setLocation"]>[0]) => {
    ignoreViewportUntil.current = Date.now() + (location.duration ?? 0) + 150;
    map.current?.setLocation(location);
  };

  useEffect(() => {
    let alive = true;
    setError("");
    setReady(false);
    void loadMapLibre().then((maplibre) => {
      if (!alive || !container.current) return;
      const firstLocation = itemsRef.current.find((item) => item.location)?.location;
      didFit.current = !!firstLocation;
      map.current = createMapLibreAdapter(maplibre, container.current, {
        center: firstLocation ? [firstLocation.longitude, firstLocation.latitude] : [37.6173, 55.7558],
        zoom: firstLocation ? 13 : 11,
        styleUrl: styleUrlRef.current,
        onLoad: () => {
          if (alive) { setError(""); setReady(true); }
        },
        onError: (message) => {
          if (alive) setError(message);
        },
        onViewport: (bounds, nextZoom) => {
          if (Date.now() < ignoreViewportUntil.current) return;
          setZoom(nextZoom);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            if (container.current) handlers.current.onViewport?.(bounds, nextZoom);
          }, 300);
        },
        onClick: (coordinates) => {
          if (coordinates) handlers.current.onPickCoordinates?.(coordinates[1], coordinates[0]);
        },
      });
      appliedStyleUrl.current = styleUrlRef.current;
    }).catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : "Не удалось загрузить карту");
    });
    return () => {
      alive = false;
      window.clearTimeout(timer.current);
      map.current?.destroy();
      map.current = null;
      appliedStyleUrl.current = null;
      setReady(false);
    };
  }, [retry]);

  useEffect(() => {
    if (!ready || !map.current) return;
    if (appliedStyleUrl.current === styleUrl) return;
    appliedStyleUrl.current = styleUrl;
    map.current.setStyle(styleUrl);
  }, [ready, styleUrl]);

  useEffect(() => {
    if (!ready || !map.current) return;
    if (!didFit.current) {
      const firstLocation = items.find((item) => item.location)?.location;
      if (firstLocation) {
        setCameraSilently({ center: [firstLocation.longitude, firstLocation.latitude], zoom: 13, duration: 300 });
        didFit.current = true;
      }
    }
    map.current.clearMarkers();
    const addMarker = (coordinates: [number, number], content: HTMLElement, options?: { anchor?: "center" | "bottom" }) => map.current?.addMarker(coordinates, content, options);
    if (userLocation) {
      const currentPosition = document.createElement("div");
      currentPosition.className = "discovery-map-user-pin";
      currentPosition.setAttribute("role", "img");
      currentPosition.setAttribute("aria-label", "Ваше примерное положение");
      addMarker([userLocation.longitude, userLocation.latitude], currentPosition);
    }
    for (const group of localClusters) {
      const button = document.createElement("button");
      button.type = "button";
      const selected = group.salons.length === 1 && group.salons[0]!.id === selectedId;
      button.className = `discovery-map-pin${group.salons.length > 1 ? " clustered" : ""}${selected ? " selected" : ""}`;
      button.setAttribute("aria-label", group.salons.length > 1
        ? `${group.salons.length} салонов на этой карте`
        : `Открыть салон «${group.salons[0]!.name}»`);
      if (group.salons.length > 1) {
        button.textContent = String(group.salons.length);
      } else {
        const salon = group.salons[0]!;
        const label = document.createElement("span");
        label.className = "discovery-map-label";
        const logo = salon.logo ?? salon.cover;
        if (logo) {
          const image = document.createElement("img");
          image.src = `/media/${logo.fileKey}`;
          image.alt = "";
          image.loading = "lazy";
          label.append(image);
        }
        const name = document.createElement("span");
        name.textContent = salon.name;
        label.append(name);
        const point = document.createElement("span");
        point.className = "discovery-map-pin-point";
        button.append(label, point);
      }
      button.title = group.salons.length > 1 ? `${group.salons.length} салонов` : group.salons[0]!.name;
      button.addEventListener("click", () => {
        if (group.salons.length === 1) handlers.current.onSelect?.(group.salons[0]!);
        else {
          map.current?.setLocation({
            center: group.center,
            zoom: Math.min(18, (map.current?.getZoom() ?? zoom) + 2),
            duration: 300,
          });
        }
      });
      if (group.salons.length === 1) {
        const root = document.createElement("span");
        root.className = "discovery-map-marker-root";
        root.append(button);
        addMarker(group.center, root);
      } else {
        addMarker(group.center, button);
      }
    }
    for (const group of clusterItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "discovery-map-pin clustered";
      button.textContent = String(group.count);
      button.setAttribute("aria-label", `Приблизить область с ${group.count} салонами`);
      button.addEventListener("click", () => {
        const isPoint = group.west === group.east && group.south === group.north;
        if (isPoint) {
          map.current?.setLocation({ center: [group.longitude, group.latitude], zoom: Math.min(18, (map.current?.getZoom() ?? zoom) + 2), duration: 300 });
        } else {
          map.current?.setLocation({ bounds: [[group.west, group.south], [group.east, group.north]], duration: 300 });
        }
      });
      addMarker([group.longitude, group.latitude], button);
    }
  }, [ready, localClusters, clusterItems, zoom, selectedId, items]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const focusLocation = selectedLocation ?? userLocation;
    if (!focusLocation) return;
    setCameraSilently({
      center: [focusLocation.longitude, focusLocation.latitude],
      zoom: Math.max(14, map.current.getZoom()),
      duration: 300,
    });
  }, [ready, selectedId, selectedLocation?.latitude, selectedLocation?.longitude, userLocation?.latitude, userLocation?.longitude]);

  return <div className="discovery-map-frame">
    <div ref={container} className="discovery-map" aria-label="Карта салонов" />
    {error && <div className="discovery-map-error" role="status">
      <strong>Карта временно недоступна</strong>
      <span>{error}. Можно продолжить поиск списком.</span>
      <button type="button" className="button secondary" onClick={() => setRetry((value) => value + 1)}>Повторить</button>
    </div>}
    {!ready && !error && <div className="discovery-map-loading" role="status">Загружаем карту…</div>}
  </div>;
}

export function LocationPicker({
  tenantId,
  latitude,
  longitude,
  address,
  city,
  styles = DEFAULT_MAP_STYLES,
  geocoderEnabled = true,
  geocoderProvider = "nominatim",
  onPick,
  onAddressResolved,
}: {
  tenantId: string;
  latitude: number | null;
  longitude: number | null;
  address: string;
  city?: string;
  styles?: MapStyles;
  geocoderEnabled?: boolean;
  geocoderProvider?: "nominatim" | "geoapify";
  onPick: (latitude: number, longitude: number) => void;
  onAddressResolved: (address: string) => void;
}) {
  const { resolvedMode } = useColorMode();
  const styleUrl = mapStyle(styles, resolvedMode);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapAdapter | null>(null);
  const drawPin = useRef<(coordinates: [number, number]) => void>(() => undefined);
  const pickHandler = useRef(onPick);
  const addressHandler = useRef(onAddressResolved);
  const point = useRef({ latitude, longitude });
  const addressValue = useRef(address);
  const styleUrlRef = useRef(styleUrl);
  const appliedStyleUrl = useRef<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [message, setMessage] = useState("");
  const [mapError, setMapError] = useState("");
  const [retryMap, setRetryMap] = useState(0);
  pickHandler.current = onPick;
  addressHandler.current = onAddressResolved;
  point.current = { latitude, longitude };
  addressValue.current = address;
  styleUrlRef.current = styleUrl;

  useEffect(() => {
    let alive = true;
    setMapError("");
    setMapReady(false);
    void loadMapLibre().then((maplibre) => {
      if (!alive || !container.current) return;
      const currentPoint = point.current;
      const hasPoint = currentPoint.latitude !== null && currentPoint.longitude !== null;
      const adapter = createMapLibreAdapter(maplibre, container.current, {
        center: hasPoint ? [currentPoint.longitude!, currentPoint.latitude!] : [37.6173, 55.7558],
        zoom: hasPoint ? 15 : 10,
        styleUrl: styleUrlRef.current,
        onLoad: () => { if (alive) setMapReady(true); },
        onError: (error) => { if (alive) setMapError(error); },
        onClick: (coordinates) => {
          if (!coordinates) return;
          drawPin.current(coordinates);
          pickHandler.current(coordinates[1], coordinates[0]);
        },
      });
      appliedStyleUrl.current = styleUrlRef.current;
      const setMarker = (coordinates: [number, number]) => {
        map.current?.clearMarkers();
        const pin = document.createElement("div");
        pin.className = "discovery-location-pin";
        pin.setAttribute("aria-hidden", "true");
        map.current?.addMarker(coordinates, pin, {
          draggable: true,
          onDragEnd: ([lng, lat]) => {
            if (Number.isFinite(lat) && Number.isFinite(lng)) pickHandler.current(lat, lng);
          },
        });
      };
      map.current = adapter;
      drawPin.current = setMarker;
      if (hasPoint) setMarker([currentPoint.longitude!, currentPoint.latitude!]);
    }).catch(() => {
      if (alive) setMapError("Карта не загрузилась. Можно ввести координаты вручную.");
    });
    return () => {
      alive = false;
      map.current?.destroy();
      map.current = null;
      appliedStyleUrl.current = null;
      drawPin.current = () => undefined;
      setMapReady(false);
    };
  }, [retryMap]);

  useEffect(() => {
    if (!map.current || !mapReady) return;
    if (appliedStyleUrl.current === styleUrl) return;
    appliedStyleUrl.current = styleUrl;
    map.current.setStyle(styleUrl);
  }, [mapReady, styleUrl]);

  useEffect(() => {
    if (!map.current || latitude === null || longitude === null) return;
    drawPin.current([longitude, latitude]);
    map.current.setLocation({ center: [longitude, latitude], zoom: 15, duration: 250 });
  }, [latitude, longitude]);

  const searchAddress = async () => {
    const addressQuery = addressValue.current.trim();
    const cityQuery = city?.trim() ?? "";
    const combinedQuery = [addressQuery, cityQuery].filter(Boolean).join(", ");
    const query = combinedQuery.length <= 300 ? combinedQuery : addressQuery.slice(0, 300);
    if (!query || !tenantId || !geocoderEnabled || searching) return;
    setSearching(true);
    setMessage("");
    try {
      const result = await api<{ latitude: number; longitude: number; address: string } | null>(
        `/tenants/${tenantId}/discovery/geocode`, "POST", { address: query },
      );
      if (!result || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) {
        setMessage("Не нашли такой адрес. Уточните улицу и дом или поставьте точку на карте.");
        return;
      }
      map.current?.setLocation({ center: [result.longitude, result.latitude], zoom: 16, duration: 300 });
      drawPin.current([result.longitude, result.latitude]);
      pickHandler.current(result.latitude, result.longitude);
      if (result.address) addressHandler.current(result.address.slice(0, 300));
      setMessage("Адрес найден. Проверьте точку на карте перед сохранением.");
    } catch {
      setMessage("Поиск адреса временно недоступен. Можно поставить пин вручную.");
    } finally {
      setSearching(false);
    }
  };

  return <div className="discovery-location-picker-shell">
    <div className="discovery-address-search">
      <button type="button" className="button secondary" disabled={!geocoderEnabled || !address.trim() || searching} onClick={() => void searchAddress()}>
        {searching ? "Ищем адрес…" : "Найти адрес на карте"}
      </button>
      {!geocoderEnabled && <small>Поиск адреса не подключён. Можно поставить точку на карте или указать координаты вручную.</small>}
      {message && <small role="status">{message}</small>}
      {geocoderEnabled && <>
        <small>Введённый адрес передаётся сервису поиска только после нажатия.</small>
        <small>{geocoderProvider === "geoapify" && <>Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a> · </>}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></small>
      </>}
    </div>
    {mapError && <div className="discovery-location-error" role="status">{mapError}<button type="button" className="text-button" onClick={() => setRetryMap((value) => value + 1)}>Повторить</button></div>}
    <div className="discovery-location-map-shell">
      <div ref={container} className="discovery-location-picker" aria-label="Выберите точку салона: нажмите на карту или перетащите пин" />
      {!mapReady && !mapError && <div className="discovery-location-map-loading" role="status">Загружаем карту…</div>}
    </div>
  </div>;
}
