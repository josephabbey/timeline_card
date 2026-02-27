import Leaflet from "leaflet";
import type {LatLon, GpsPoint, Segment, StaySegment, Track} from "./types";
import {getTrackColor} from "./utils";

function toLeafletLatLng(coord: LatLon): Leaflet.LatLngExpression {
    return {lat: coord.lat, lng: coord.lon};
}

const DEFAULT_CENTER: [number, number] = [52.3731339, 4.8903147];
const DEFAULT_ZOOM = 13;

interface MapPath {
    entityIndex?: number;
    isActive?: boolean;
    points: GpsPoint[];
    color: string;
    opacity: number;
    weight: number;
    borderWeight?: number;
}

interface SetDaySegmentsOptions {
    tracks?: Track[];
    activeEntityIndex?: number;
    onTrackClick?: ((entityIndex: number) => void) | null;
    colors?: string[];
}

interface FitMapOptions {
    defer?: boolean;
    bounds?: LatLon[] | null;
    pad?: number;
}

export class TimelineLeafletMap {
    private _Leaflet: typeof Leaflet;
    private _mapElement: HTMLElement;
    private _leafletMap: Leaflet.Map;
    private _tileLayer: Leaflet.TileLayer;
    private _mapLayers: Leaflet.Layer[];
    private _fullDayPaths: MapPath[];
    private _fullDayPath: MapPath;
    private _highlightedPath: MapPath[];
    private _highlightedStay: StaySegment | null;
    private _isTravelHighlightActive: boolean;
    private _isMapZoomedToSegmentValue: boolean;
    private _activeTrackColor: string;
    private _onTrackClick: ((entityIndex: number) => void) | null;

    constructor(mapElement: HTMLElement) {
        if (!mapElement?.isConnected) {
            throw new Error("Cannot setup Leaflet map on disconnected element");
        }

        this._Leaflet = Leaflet;
        this._mapElement = mapElement;
        this._leafletMap = Leaflet.map(mapElement, {
            zoomControl: true,
        });

        this._tileLayer = createTileLayer(Leaflet).addTo(this._leafletMap);
        this._leafletMap.setView(DEFAULT_CENTER, DEFAULT_ZOOM);

        this._mapLayers = [];
        this._fullDayPaths = [];
        this._fullDayPath = {points: [], color: "", opacity: 1, weight: 4};
        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;
        this._isMapZoomedToSegmentValue = false;
        this._activeTrackColor = "var(--primary-color)";
        this._onTrackClick = null;

        this.setDarkMode(false);

        requestAnimationFrame(() => this._leafletMap.invalidateSize());
    }

    setDarkMode(isDarkMode: boolean): void {
        this._mapElement?.classList.toggle("dark", Boolean(isDarkMode));
    }

    destroy(): void {
        this._leafletMap.remove();
        this._mapLayers = [];
        this._fullDayPath = {points: [], color: "", opacity: 1, weight: 4};
        this._fullDayPaths = [];
        this._highlightedPath = [];
        this._highlightedStay = null;
    }

    get isMapZoomedToSegment(): boolean {
        return this._isMapZoomedToSegmentValue;
    }

    setDaySegments({
        tracks = [],
        activeEntityIndex = 0,
        onTrackClick = null,
        colors = [],
    }: SetDaySegmentsOptions): void {
        this._fullDayPaths = tracks.map((track, index) => {
            const points: GpsPoint[] = [];
            const segments = Array.isArray(track?.segments) ? track.segments : [];
            segments.forEach((segment) => {
                if (segment?.type === "stay" && segment.center) {
                    points.push({point: [segment.center.lat, segment.center.lon], timestamp: segment.start});
                }
                if (segment?.type === "move" && Array.isArray(segment.points)) {
                    points.push(...segment.points);
                }
            });

            return {
                entityIndex: index,
                isActive: index === activeEntityIndex,
                points,
                color: getTrackColor(index, colors),
                opacity: index === activeEntityIndex ? 1 : 0.8,
                weight: 4,
                borderWeight: 7,
            };
        });

        this._fullDayPath = this._fullDayPaths[activeEntityIndex] || {points: [], color: "", opacity: 1, weight: 4};
        this._activeTrackColor = this._fullDayPaths[activeEntityIndex]?.color || "var(--primary-color)";
        this._onTrackClick = typeof onTrackClick === "function" ? onTrackClick : null;

        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;
        this._isMapZoomedToSegmentValue = false;

        const activeSegments = tracks[activeEntityIndex]?.segments || [];
        this._drawMapPaths(activeSegments);
    }

    highlightSegment(segment: Segment, segments: Segment[]): void {
        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;

        if (segment?.type === "stay") {
            this._highlightedStay = segment;
        } else if (segment?.type === "move") {
            this._highlightedPath = [
                {points: segment.points, color: "var(--accent-color)", weight: 7, opacity: 1, borderWeight: 10},
            ];
            this._isTravelHighlightActive = true;
        }

        this._drawMapPaths(segments);
    }

    clearHighlight(segments: Segment[]): void {
        if (!this._highlightedPath.length && !this._highlightedStay && !this._isTravelHighlightActive) {
            return;
        }

        this._highlightedPath = [];
        this._highlightedStay = null;
        this._isTravelHighlightActive = false;

        this._drawMapPaths(segments);
    }

    resetMapZoom(): void {
        this._isMapZoomedToSegmentValue = false;
        this.fitMap();
    }

    zoomToStay(stay: StaySegment): void {
        if (!stay?.center) return;
        this._isMapZoomedToSegmentValue = true;
        this.fitMap({bounds: [stay.center], defer: false});
    }

    zoomToPoints(points: LatLon[]): void {
        if (!Array.isArray(points) || points.length < 2) return;
        this._isMapZoomedToSegmentValue = true;
        this.fitMap({bounds: points, defer: false});
    }

    fitMap({defer = false, bounds = null, pad = 0.1}: FitMapOptions = {}): void {
        if (bounds === null) {
            const mappedPoints =
                this._fullDayPath?.points?.map((point) => ({lat: point.point[0], lon: point.point[1]})) || [];
            if (!mappedPoints.length) return;
            bounds = mappedPoints;
        }

        const normalizedBounds = bounds
            .map(normalizeLatLng)
            .filter(
                (point): point is {lat: number; lng: number} =>
                    point !== null && Number.isFinite(point.lat) && Number.isFinite(point.lng),
            );
        if (!normalizedBounds.length) return;

        const paddedBounds = this._Leaflet.latLngBounds(normalizedBounds).pad(pad);
        const doFit = () => this._leafletMap.fitBounds(paddedBounds, {maxZoom: 14});

        if (defer) {
            requestAnimationFrame(() => requestAnimationFrame(doFit));
        } else {
            doFit();
        }
    }

    private _drawMapPaths(segments: Segment[]): void {
        this._mapLayers.forEach((layer) => layer.remove());
        this._mapLayers = [];

        this._drawMapLines();
        this._drawMapMarkers(segments);
        this._mapLayers.forEach((layer) => this._leafletMap.addLayer(layer));
    }

    private _drawMapMarkers(segments: Segment[]): void {
        const stayMarkers = Array.isArray(segments)
            ? segments.filter((segment): segment is StaySegment => segment?.type === "stay")
            : [];

        stayMarkers.forEach((stay) => {
            const icon = createMarkerIcon({
                iconName: stay.zoneIcon || "mdi:map-marker",
                markerSize: 18,
                iconSize: 14,
                backgroundColor: this._activeTrackColor,
                borderColor: `color-mix(in srgb, black 30%, ${this._activeTrackColor})`,
                iconPadding: "2px",
                leafletIconSize: [22, 22] as [number, number],
            });

            this._mapLayers.push(this._Leaflet.marker(toLeafletLatLng(stay.center), {icon, zIndexOffset: 100}));
        });

        if (!this._highlightedStay) return;

        const icon = createMarkerIcon({
            iconName: this._highlightedStay.zoneIcon || "mdi:map-marker",
            markerSize: 22,
            iconSize: 22,
            backgroundColor: "var(--accent-color)",
            borderColor: "color-mix(in srgb, black 30%, var(--accent-color))",
            leafletIconSize: [26, 26] as [number, number],
        });

        this._mapLayers.push(
            this._Leaflet.marker(toLeafletLatLng(this._highlightedStay.center), {icon, zIndexOffset: 1000}),
        );
    }

    private _drawMapLines(): void {
        const inactivePaths = this._fullDayPaths.filter((path) => !path.isActive);
        const activePaths = this._fullDayPaths.filter((path) => path.isActive);
        const paths = [...inactivePaths, ...activePaths, ...this._highlightedPath];

        paths.forEach((path) => {
            if (!Array.isArray(path.points) || path.points.length < 2) return;
            const latLngs = path.points.map((point) => point.point);

            if (path.isActive || path.entityIndex === undefined) {
                this._mapLayers.push(
                    this._Leaflet.polyline(latLngs, {
                        color: `color-mix(in srgb, black 30%, ${path.color})`,
                        opacity: path.opacity ?? 1,
                        weight: path.borderWeight ?? path.weight + 3,
                    }),
                );
            }

            const line = this._Leaflet.polyline(latLngs, {
                color: path.color,
                opacity: path.opacity ?? 1,
                weight: path.weight,
            });
            line.on("click", () => {
                if (!Number.isInteger(path.entityIndex) || !this._onTrackClick) return;
                this._onTrackClick(path.entityIndex!);
            });
            this._mapLayers.push(line);
        });
    }
}

interface MarkerIconOptions {
    iconName: string;
    markerSize: number;
    iconSize: number;
    backgroundColor: string;
    borderColor: string;
    leafletIconSize: [number, number];
    iconPadding?: string;
}

const createMarkerIcon = ({
    iconName,
    markerSize,
    iconSize,
    backgroundColor,
    borderColor,
    leafletIconSize,
    iconPadding = "0",
}: MarkerIconOptions): Leaflet.DivIcon => {
    const haIcon = document.createElement("ha-icon");
    haIcon.setAttribute("icon", iconName);
    haIcon.setAttribute("style", `color: white; --mdc-icon-size: ${iconSize}px; padding: ${iconPadding}`);

    const iconDiv = document.createElement("div");
    iconDiv.appendChild(haIcon);
    iconDiv.setAttribute(
        "style",
        `height: ${markerSize}px; width: ${markerSize}px; background-color: ${backgroundColor}; border-radius: 50%; border: 2px solid ${borderColor}; display: flex;`,
    );

    return Leaflet.divIcon({html: iconDiv, className: "my-leaflet-icon", iconSize: leafletIconSize});
};

const createTileLayer = (leaflet: typeof Leaflet): Leaflet.TileLayer =>
    leaflet.tileLayer(
        `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}${leaflet.Browser.retina ? "@2x.png" : ".png"}`,
        {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: "abcd",
            minZoom: 0,
            maxZoom: 20,
        },
    );

const normalizeLatLng = (
    point: LatLon | [number, number] | Record<string, unknown>,
): {lat: number; lng: number} | null => {
    if (Array.isArray(point) && point.length >= 2) {
        return {lat: Number(point[0]), lng: Number(point[1])};
    }
    if (!point || typeof point !== "object") return null;
    const p = point as Record<string, unknown>;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        return {lat: Number(p.lat), lng: Number(p.lng)};
    }
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        return {lat: Number(p.lat), lng: Number(p.lon)};
    }
    return null;
};
