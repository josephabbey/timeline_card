import css from "./card.css";
import leafletCss from "leaflet/dist/leaflet.css";
import {fetchEntityHistory, fetchHistory} from "./history";
import {segmentTimeline} from "./segmentation";
import {formatDate, getTrackColor, startOfDay, toDateKey, toLatLon} from "./utils";
import {TimelineLeafletMap} from "./leaflet-map";
import {clearPersistentCache, clearReverseGeocodingQueue, resolveStaySegments} from "./reverse-geocoding";
import {resolveMoveSegments} from "./activity";
import {renderTimeline} from "./timeline";
import {getConfigFormSchema} from "./config-flow";
import type {DayData, GpsPoint, HassLike, Segment, StaySegment, TimelineCardConfig, Track, Zone} from "./types";

interface CustomCardsEntry {
    type: string;
    name: string;
    description: string;
}

declare global {
    interface Window {
        customCards: CustomCardsEntry[];
    }
}

const DEFAULT_CONFIG: TimelineCardConfig = {
    entity: [],
    places_entity: [],
    activity_entity: [],
    osm_api_key: null,
    stay_radius_m: 75,
    min_stay_minutes: 10,
    map_appearance: "auto",
    map_height_px: 200,
    colors: [],
    debug: false,
};

class TimelineCard extends HTMLElement {
    private _config: TimelineCardConfig;
    private _cache: Map<string, DayData>;
    private _selectedDate: Date;
    private _hass: HassLike | null;
    private _rendered: boolean;
    private _touchStart: {x: number; y: number} | null;
    private _activeEntityIndex: number;
    private _mapView?: TimelineLeafletMap;
    private _baseLayoutReady?: boolean;
    private _isLoadingMap?: boolean;

    constructor() {
        super();
        this.attachShadow({mode: "open"});
        this._config = {...DEFAULT_CONFIG};
        this._cache = new Map();
        this._selectedDate = startOfDay(new Date());
        this._hass = null;
        this._rendered = false;
        this._touchStart = null;
        this._activeEntityIndex = 0;

        this.shadowRoot!.addEventListener("click", (event) => {
            const target = (event.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
            if (!target) return;
            const action = target.dataset.action;
            if (action === "prev") {
                this._shiftDate(-1);
            } else if (action === "next") {
                this._shiftDate(1);
            } else if (action === "refresh") {
                this._refreshCurrentDay();
            } else if (action === "debug") {
                this._logCacheToConsole();
            } else if (action === "open-date-picker") {
                this._openDatePicker();
            } else if (action === "reset-map-zoom") {
                this._resetMapZoom();
            } else if (action === "select-entity") {
                this._setActiveEntityIndex(Number(target.dataset.entityIndex));
            }
        });


        this.shadowRoot!.addEventListener("change", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) || target.id !== "timeline-date-picker") return;
            if (!target.value) return;
            const next = new Date(`${target.value}T00:00:00`);
            if (!Number.isNaN(next.getTime())) {
                this._selectedDate = startOfDay(next);
                this._ensureDay(this._selectedDate).then(() => this._render());
            }
        });

        this.shadowRoot!.addEventListener("mouseover", (event: Event) => {
            const mouseEvent = event as MouseEvent;
            const entry = (mouseEvent.target as HTMLElement).closest("[data-segment-index]") as HTMLElement | null;
            if (!entry || !this.shadowRoot!.contains(entry)) return;
            if (entry.contains(mouseEvent.relatedTarget as Node)) return;
            this._handleSegmentHoverStart(Number(entry.dataset.segmentIndex));
        });

        this.shadowRoot!.addEventListener("mouseout", (event: Event) => {
            const mouseEvent = event as MouseEvent;
            const entry = (mouseEvent.target as HTMLElement).closest("[data-segment-index]") as HTMLElement | null;
            if (!entry || !this.shadowRoot!.contains(entry)) return;
            if (entry.contains(mouseEvent.relatedTarget as Node)) return;
            this._clearHoverHighlight();
        });

        this.shadowRoot!.addEventListener("click", (event) => {
            const entry = (event.target as HTMLElement).closest("[data-segment-index]") as HTMLElement | null;
            if (!entry || !this.shadowRoot!.contains(entry)) return;
            this._handleSegmentClick(Number(entry.dataset.segmentIndex));
        });
    }

    setConfig(config: Partial<TimelineCardConfig> & {entity: string | string[]}): void {
        if (!config || !config.entity) {
            throw new Error("You need to define an entity");
        }
        this._config = {...DEFAULT_CONFIG, ...config} as TimelineCardConfig;
        if (config.distance_unit === undefined) {
            this._config.distance_unit = "metric";
        } else if (config.distance_unit !== "metric" && config.distance_unit !== "imperial") {
            throw new Error("distance_unit must be either 'metric' or 'imperial'");
        }
        this._config.map_appearance = this._config.map_appearance ?? "auto";
        if (!["auto", "light", "dark"].includes(this._config.map_appearance)) {
            throw new Error("map_appearance must be one of 'auto', 'light', or 'dark'");
        }
        this._activeEntityIndex = 0;
        this._cache.clear();
        if (this._config.debug) {
            clearPersistentCache();
        }
        this._selectedDate = startOfDay(new Date());
        this._syncMapAppearance();
        this._applyMapHeight();
        if (this._hass) {
            this._ensureDay(this._selectedDate);
        }
        this._render();
    }

    set hass(hass: HassLike) {
        this._hass = hass;
        this._syncMapAppearance();
        if (!this._config.entity) return;
        const dateKey = toDateKey(this._selectedDate);
        if (!this._cache.has(dateKey)) {
            this._ensureDay(this._selectedDate);
        }
        if (!this._rendered) {
            this._render();
            this._rendered = true;
        }
    }

    static getConfigForm(): ReturnType<typeof getConfigFormSchema> {
        return getConfigFormSchema();
    }

    private _syncMapAppearance(): void {
        let darkMode = Boolean(this._hass?.themes?.darkMode);
        if (this._config.map_appearance === "dark") {
            darkMode = true;
        } else if (this._config.map_appearance === "light") {
            darkMode = false;
        }
        this._mapView?.setDarkMode(darkMode);
    }

    private _applyMapHeight(): void {
        const mapElement = this.shadowRoot?.getElementById("overview-map");
        if (!mapElement) return;
        mapElement.style.setProperty("height", `${this._config.map_height_px}px`, "important");
    }

    getCardSize(): number {
        return 6;
    }

    private _shiftDate(direction: number): void {
        clearReverseGeocodingQueue();

        const today = startOfDay(new Date());
        if (direction > 0 && this._selectedDate >= today) {
            return;
        }

        const next = new Date(this._selectedDate);
        next.setDate(next.getDate() + direction);
        this._selectedDate = startOfDay(next);
        this._ensureDay(this._selectedDate).then(() => this._render());
    }

    private _resetMapZoom(): void {
        this._mapView?.resetMapZoom();
        this._updateMapResetButton();
    }

    private _refreshCurrentDay(): void {
        const key = toDateKey(this._selectedDate);
        this._cache.delete(key);
        this._ensureDay(this._selectedDate).then(() => this._render());
    }

    private _logCacheToConsole(): void {
        console.log("%c[Location Timeline Debug]", "color: white; background-color: #03a9f4; font-weight: bold;");
        console.log(JSON.stringify(this._cache.get(toDateKey(this._selectedDate))));
    }

    private async _ensureDay(date: Date): Promise<void> {
        const key = toDateKey(date);
        const existing = this._cache.get(key);
        if (existing && (existing.tracks || existing.loading)) return;

        this._cache.set(key, {loading: true, tracks: null, error: null});

        try {
            const entities = this._getEntities();
            const placesByEntity = this._getPlacesEntityMap();
            const activityByEntity = this._getActivityEntityMap();
            const zones = this._collectZones();
            const tracks: Track[] = await Promise.all(entities.map(async (entityId) => {
                const points = await fetchHistory(this._hass!, entityId, date);
                const placeEntityId = placesByEntity.get(entityId) || null;
                const placeStates = placeEntityId
                    ? await fetchEntityHistory(this._hass!, placeEntityId, date)
                    : [];
                const activityEntityId = activityByEntity.get(entityId) || null;
                const activityStates = activityEntityId
                    ? await fetchEntityHistory(this._hass!, activityEntityId, date)
                    : [];
                const segments = segmentTimeline(points, {
                    stayRadiusM: this._config.stay_radius_m,
                    minStayMinutes: this._config.min_stay_minutes,
                }, zones);
                resolveStaySegments(segments, {
                    placeStates,
                    date,
                    osmApiKey: this._config.osm_api_key,
                    onUpdate: () => {
                        const day = this._cache.get(key);
                        if (!day || !day.tracks) return;
                        this._render();
                    },
                });
                resolveMoveSegments(segments, activityStates, date);

                return {entityId, placeEntityId, points, segments};
            }));

            this._cache.set(key, {
                loading: false,
                tracks,
                error: null,
            });
        } catch (err) {
            console.warn("Timeline card: history fetch failed", err);
            this._cache.set(key, {
                loading: false, tracks: null, error: this._formatErrorMessage(err),
            });
        }
        this._render();
        requestAnimationFrame(() => {
            this._refreshMapPaths();
        });
    }

    private _collectZones(): Zone[] {
        if (!this._hass || !this._hass.states) return [];
        return Object.values(this._hass.states)
                     .filter((state) => state.entity_id && state.entity_id.startsWith("zone.") && state.attributes?.passive !== true)
                     .map((state) => ({
                         name: (state.attributes?.friendly_name as string) || state.entity_id,
                         icon: (state.attributes?.icon as string) || null,
                         lat: Number(state.attributes?.latitude),
                         lon: Number(state.attributes?.longitude),
                         radius: Number(state.attributes?.radius) || 100,
                     }))
                     .filter((zone) => Number.isFinite(zone.lat) && Number.isFinite(zone.lon));
    }

    private _render(): void {
        if (!this.shadowRoot) return;
        this._ensureBaseLayout();

        const dateKey = toDateKey(this._selectedDate);
        const dayData = this._cache.get(dateKey) || {
            loading: false, tracks: null, error: null
        };
        const isFuture = this._selectedDate >= startOfDay(new Date());

        const dateEl = this.shadowRoot.getElementById("timeline-date")!;
        dateEl.textContent = formatDate(this._selectedDate);

        const datePicker = this.shadowRoot.getElementById("timeline-date-picker") as HTMLInputElement;
        datePicker.value = toDateKey(this._selectedDate);
        datePicker.max = toDateKey(new Date());

        const nextButton = this.shadowRoot.querySelector("[data-action='next']") as HTMLElement;
        nextButton.toggleAttribute("disabled", isFuture);

        this._applyMapHeight();

        const body = this.shadowRoot.getElementById("timeline-body")!;
        const selector = this.shadowRoot.getElementById("entity-selector")!;
        selector.innerHTML = this._renderEntitySelector();
        selector.toggleAttribute("hidden", this._getEntities().length < 2);
        this._bindTimelineTouch(body);
        this._updateMapResetButton();
        const activeDayData = this._getCurrentTrackDayData(dayData);
        body.innerHTML = this._renderTimelineContent(activeDayData);

        this._attachMapCard();
        requestAnimationFrame(() => {
            this._refreshMapPaths();
        });
        this._rendered = true;
    }

    private _ensureBaseLayout(): void {
        if (this._baseLayoutReady) return;
        this._baseLayoutReady = true;

        this.shadowRoot!.innerHTML = `
          <style>${css}\n${leafletCss}</style>
          <ha-card>
            <div class="card">
              <div class="map-wrap">
                <div id="overview-map"></div>
                <ha-icon-button id="map-reset-zoom" class="map-reset" data-action="reset-map-zoom" label="Reset map zoom" hidden><ha-icon icon="mdi:magnify-expand"></ha-icon></ha-icon-button>
              </div>
              <div class="header my-header">
                <div class="header-actions">
                    <ha-icon-button class="nav-button" data-action="prev" label="Previous day"><ha-icon icon="mdi:chevron-left"></ha-icon></ha-icon-button>
                    ${this._config.debug ? `<ha-icon-button class="nav-button" data-action="debug" label="Debug"><ha-icon icon="mdi:bug"></ha-icon></ha-icon-button>` : ""}
                </div>
                <div class="date-wrap">
                  <button class="date-trigger" data-action="open-date-picker" type="button" aria-label="Pick date">
                    <span id="timeline-date" class="date"></span>
                    <ha-icon class="date-caret" icon="mdi:menu-down"></ha-icon>
                  </button>
                  <input id="timeline-date-picker" class="date-picker-input" type="date">
                </div>
                <div class="header-actions">
                  <ha-icon-button class="nav-button" data-action="refresh" label="Refresh"><ha-icon icon="mdi:refresh"></ha-icon></ha-icon-button>
                  <ha-icon-button class="nav-button" data-action="next" label="Next day"><ha-icon icon="mdi:chevron-right"></ha-icon></ha-icon-button>
                </div>
              </div>
              <div id="entity-selector" class="entity-selector" hidden></div>
              <div id="timeline-body" class="body"></div>
            </div>
          </ha-card>
        `;
    }


    private _openDatePicker(): void {
        const input = this.shadowRoot?.getElementById("timeline-date-picker") as HTMLInputElement | null;
        if (!input) return;
        if (typeof (input as HTMLInputElement & {showPicker?: () => void}).showPicker === "function") {
            (input as HTMLInputElement & {showPicker: () => void}).showPicker();
            return;
        }
        input.focus();
        input.click();
    }

    private _updateMapResetButton(): void {
        const resetBtn = this.shadowRoot?.getElementById("map-reset-zoom");
        if (!resetBtn) return;
        resetBtn.toggleAttribute("hidden", !this._mapView?.isMapZoomedToSegment);
    }

    private _bindTimelineTouch(body: HTMLElement): void {
        if (!body || (body as HTMLElement & {dataset: DOMStringMap}).dataset.swipeBound === "true") return;
        body.dataset.swipeBound = "true";

        body.addEventListener("touchstart", (event) => {
            const touch = event.changedTouches?.[0];
            if (!touch) return;
            this._touchStart = {x: touch.clientX, y: touch.clientY};
        }, {passive: true});

        body.addEventListener("touchend", (event) => {
            const touch = event.changedTouches?.[0];
            if (!touch || !this._touchStart) return;

            const deltaX = touch.clientX - this._touchStart.x;
            const deltaY = touch.clientY - this._touchStart.y;
            this._touchStart = null;

            if (Math.abs(deltaX) < 60 || Math.abs(deltaX) < Math.abs(deltaY)) {
                return;
            }

            this._shiftDate(deltaX > 0 ? -1 : 1);
        }, {passive: true});
    }

    private async _attachMapCard(): Promise<void> {
        const container = this.shadowRoot!.getElementById("overview-map");
        if (!container || this._mapView || this._isLoadingMap) return;
        if (!this.isConnected || !container.isConnected) {
            requestAnimationFrame(() => this._attachMapCard());
            return;
        }

        this._isLoadingMap = true;
        try {
            this._mapView = new TimelineLeafletMap(container);
            this._syncMapAppearance();
            this._refreshMapPaths();
            this._mapView.fitMap({defer: true});
        } catch (err) {
            console.warn("Timeline card: map setup failed", err);
        } finally {
            this._isLoadingMap = false;
        }
    }

    private _refreshMapPaths(): void {
        const dayData = this._getCurrentDayData();
        if (!dayData || dayData.loading || dayData.error || !this._mapView) return;

        try {
            const tracks = Array.isArray(dayData.tracks) ? dayData.tracks : [];
            this._mapView.setDaySegments({
                tracks,
                activeEntityIndex: this._activeEntityIndex,
                onTrackClick: (entityIndex: number) => this._setActiveEntityIndex(entityIndex),
                colors: this._getColors(),
            });
            this._touchStart = null;

            this._updateMapResetButton();
            this._mapView.fitMap();
        } catch (err) {
            this._setCurrentDayError(err);
            this._render();
        }
    }

    private _handleSegmentHoverStart(segmentIndex: number): void {
        if (!Number.isInteger(segmentIndex)) return;
        const dayData = this._getCurrentDayData();
        const track = this._getCurrentTrackDayData(dayData);
        if (!track || !Array.isArray(track.segments)) return;

        const segment = track.segments[segmentIndex];
        if (!segment || !this._mapView) return;

        const segments = Array.isArray(track.segments) ? track.segments : [];
        this._touchStart = null;
        this._mapView.highlightSegment(segment, segments);
    }

    private _clearHoverHighlight(): void {
        if (!this._mapView) return;
        const dayData = this._getCurrentDayData();
        const track = this._getCurrentTrackDayData(dayData);
        const segments = Array.isArray(track?.segments) ? track.segments : [];
        this._touchStart = null;
        this._mapView.clearHighlight(segments);
    }

    private _handleSegmentClick(segmentIndex: number): void {
        if (!Number.isInteger(segmentIndex)) return;
        const dayData = this._getCurrentDayData();
        const track = this._getCurrentTrackDayData(dayData);
        if (!track || !Array.isArray(track.segments)) return;

        const segment = track.segments[segmentIndex];
        if (!segment) return;

        if (segment.type === "stay") {
            this._copyStayCoordinatesToClipboard(segment);
            this._mapView?.zoomToStay(segment);
            this._updateMapResetButton();
        } else if (segment.type === "move") {
            const segmentPoints = this._extractSegmentPoints(track.points, segment);
            if (segmentPoints.length < 2) return;
            this._mapView?.zoomToPoints(segmentPoints.map(toLatLon));
            this._updateMapResetButton();
        }
    }

    private _copyStayCoordinatesToClipboard(segment: StaySegment): void {
        const lat = Number(segment?.center?.lat);
        const lon = Number(segment?.center?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

        if (navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(value).catch(() => {});
        }
    }

    private _extractSegmentPoints(points: GpsPoint[], segment: Segment): GpsPoint[] {
        if (!Array.isArray(points)) return [];
        return points.filter((point) => point.timestamp >= segment.start && point.timestamp <= segment.end);
    }

    private _getCurrentDayData(): DayData | undefined {
        return this._cache.get(toDateKey(this._selectedDate));
    }

    private _getCurrentTrackDayData(dayData: DayData | undefined = this._getCurrentDayData()): Track {
        const tracks = Array.isArray(dayData?.tracks) ? dayData!.tracks! : [];
        const index = Math.min(this._activeEntityIndex, Math.max(0, tracks.length - 1));
        this._activeEntityIndex = index;
        return tracks[index] || {segments: [], points: [], entityId: null, placeEntityId: null};
    }

    private _setActiveEntityIndex(index: number): void {
        const entities = this._getEntities();
        if (!Number.isInteger(index) || index < 0 || index >= entities.length || index === this._activeEntityIndex) {
            return;
        }
        this._activeEntityIndex = index;
        this._render();
    }

    private _getEntities(): string[] {
        const entities = this._normalizeEntityList(this._config.entity);
        if (!entities.length) {
            throw new Error("You need to define an entity");
        }
        return entities;
    }

    private _getPlacesEntityMap(): Map<string, string> {
        const placeEntityIds = this._normalizeEntityList(this._config.places_entity);
        const trackedEntities = new Set(this._getEntities());
        const map = new Map<string, string>();

        placeEntityIds.forEach((placeEntityId) => {
            const trackerEntityId = this._hass?.states?.[placeEntityId]?.attributes?.devicetracker_entityid as string | undefined;
            if (!trackerEntityId || !trackedEntities.has(trackerEntityId) || map.has(trackerEntityId)) {
                return;
            }
            map.set(trackerEntityId, placeEntityId);
        });

        return map;
    }

    private _getActivityEntityMap(): Map<string, string> {
        const activityEntityIds = this._normalizeEntityList(this._config.activity_entity);
        const trackedEntities = this._getEntities();
        const map = new Map<string, string>();

        if (activityEntityIds.length == trackedEntities.length) {
            trackedEntities.forEach((entityId, index) => {
                map.set(entityId, activityEntityIds[index]);
            });
        }

        return map;
    }

    private _normalizeEntityList(value: string | string[] | undefined): string[] {
        if (!value) return [];
        const list = Array.isArray(value) ? value : [value];
        return list.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
    }

    private _getColors(): string[] {
        const list = this._config?.colors;
        if (!list) return [];
        const values = Array.isArray(list) ? list : String(list).split(",");
        return values
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean);
    }

    private _renderEntitySelector(): string {
        const entities = this._getEntities();
        if (entities.length < 2) return "";

        return entities.map((entityId, index) => {
            const state = this._hass?.states?.[entityId];
            const picture = state?.attributes?.entity_picture as string | undefined;
            const name = (state?.attributes?.friendly_name as string) || entityId;
            const escapedName = this._escapeHtml(name);
            const escapedPicture = this._escapeHtml(picture || "");
            const trackColor = getTrackColor(index, this._getColors());
            return `
              <button type="button" style="--entity-track-color:${trackColor};" class="entity-chip ${index === this._activeEntityIndex ? "active" : ""}" data-action="select-entity" data-entity-index="${index}">
                ${picture ? `<img src="${escapedPicture}" alt="${escapedName}">` : "<ha-icon class=\"entity-avatar-icon\" icon=\"mdi:account-circle\"></ha-icon>"}
                <span>${escapedName}</span>
              </button>
            `;
        }).join("");
    }

    private _escapeHtml(text: string): string {
        return String(text || "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll("\"", "&quot;");
    }

    private _renderTimelineContent(dayData: {segments?: Segment[]; error?: string | null; loading?: boolean}): string {
        const errorHtml = dayData.error ? `<div class="error">${dayData.error}</div>` : "";
        const loadingHtml = dayData.loading ? `<div class="loading">Loading timeline...</div>` : "";
        if (dayData.loading || dayData.error) {
            return `${errorHtml}${loadingHtml}`;
        }

        try {
            return renderTimeline(dayData.segments || [], {
                locale: this._hass?.locale,
                distanceUnit: this._config.distance_unit,
            });
        } catch (err) {
            const message = this._formatErrorMessage(err);
            console.warn("Timeline card: timeline render failed", err);
            this._setCurrentDayError(err);
            return `<div class="error">${message}</div>`;
        }
    }

    private _setCurrentDayError(err: unknown): void {
        const key = toDateKey(this._selectedDate);
        const current = this._cache.get(key) || {loading: false, tracks: null, error: null};
        this._cache.set(key, {...current, loading: false, error: this._formatErrorMessage(err)});
    }

    private _formatErrorMessage(err: unknown): string {
        const message = err && (err as Error).message ? String((err as Error).message) : "";
        if (message.toLowerCase().includes("unknown command")) {
            return "History WebSocket API not available. Ensure the Recorder/History integration is enabled.";
        }
        return message || "Unable to load history";
    }
}

customElements.define("location-timeline-card", TimelineCard);

window.customCards = window.customCards || [];
window.customCards.push({
    type: "location-timeline-card",
    name: "Location Timeline Card",
    description: "Daily location timeline from GPS history.",
});
