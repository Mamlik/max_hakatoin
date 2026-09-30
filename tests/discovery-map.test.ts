import { describe, expect, it } from "vitest";
import { createMapLibreAdapter, mapClickCoordinates } from "../apps/web/src/map-adapter";

describe("map coordinates", () => {
  it("reads valid geographic coordinates from MapLibre click events", () => {
    expect(mapClickCoordinates({ lngLat: { lng: 37.6173, lat: 55.7558 } })).toEqual([37.6173, 55.7558]);
  });

  it("ignores missing and out-of-range coordinates", () => {
    expect(mapClickCoordinates(null)).toBeNull();
    expect(mapClickCoordinates({ lngLat: { lng: 181, lat: 55 } })).toBeNull();
    expect(mapClickCoordinates({ lngLat: { lng: 37, lat: NaN } })).toBeNull();
  });

  it("keeps viewport, click, marker lifecycle, and provider controls behind the adapter", () => {
    const eventHandlers = new Map<string, (event?: any) => void>();
    const onceHandlers = new Map<string, (event?: any) => void>();
    const markers: any[] = [];
    let instance: any;
    class FakeMap {
      center: [number, number];
      zoom: number;
      style: string;
      removed = false;
      bounds = { getWest: () => 37.4, getSouth: () => 55.5, getEast: () => 37.8, getNorth: () => 55.9 };
      constructor(_options: any) { instance = this; this.center = _options.center; this.zoom = _options.zoom; this.style = _options.style; }
      addControl(_control: any) {}
      once(event: string, callback: (event?: any) => void) { onceHandlers.set(event, callback); }
      on(event: string, callback: (event?: any) => void) { eventHandlers.set(event, callback); }
      isStyleLoaded() { return true; }
      getBounds() { return this.bounds; }
      getZoom() { return this.zoom; }
      easeTo(options: any) { this.center = options.center; this.zoom = options.zoom; }
      fitBounds() {}
      setStyle(url: string) { this.style = url; }
      remove() { this.removed = true; }
    }
    class FakeMarker {
      coordinates: [number, number] = [0, 0];
      removed = false;
      callback?: () => void;
      constructor(public options: any) { markers.push(this); }
      setLngLat(coordinates: [number, number]) { this.coordinates = coordinates; return this; }
      addTo(_map: any) { return this; }
      on(_event: string, callback: () => void) { this.callback = callback; return this; }
      getLngLat() { return { lng: this.coordinates[0], lat: this.coordinates[1] }; }
      remove() { this.removed = true; }
    }
    class FakeNavigationControl {}
    const clicks: Array<[number, number] | null> = [];
    const viewports: unknown[] = [];
    const adapter = createMapLibreAdapter({
      Map: FakeMap,
      Marker: FakeMarker,
      NavigationControl: FakeNavigationControl,
    } as unknown as typeof import("maplibre-gl"), {} as HTMLElement, {
      center: [37, 55], zoom: 10, styleUrl: "light",
      onClick: (coordinates) => clicks.push(coordinates),
      onViewport: (bounds, zoom) => viewports.push({ bounds, zoom }),
    });

    expect(instance.center).toEqual([37, 55]);
    expect(instance.style).toBe("light");
    eventHandlers.get("click")?.({ lngLat: { lng: 37.6, lat: 55.7 } });
    eventHandlers.get("moveend")?.();
    eventHandlers.get("moveend")?.();
    expect(clicks).toEqual([[37.6, 55.7]]);
    expect(viewports).toEqual([{ bounds: { west: 37.4, east: 37.8, south: 55.5, north: 55.9 }, zoom: 10 }]);

    let dragged: [number, number] | undefined;
    adapter.addMarker([37.6, 55.7], {} as HTMLElement, { draggable: true, onDragEnd: (point) => { dragged = point; } });
    markers[0].coordinates = [37.7, 55.8];
    markers[0].callback?.();
    expect(dragged).toEqual([37.7, 55.8]);
    adapter.setLocation({ center: [38, 56], zoom: 13 });
    expect(instance.center).toEqual([38, 56]);
    adapter.setStyle("dark");
    expect(instance.style).toBe("dark");
    adapter.clearMarkers();
    expect(markers[0].removed).toBe(true);
    adapter.destroy();
    expect(instance.removed).toBe(true);
    expect(onceHandlers.has("load")).toBe(true);
  });
});
