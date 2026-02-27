// ── Geo primitives ──

export interface LatLon {
    lat: number;
    lon: number;
}

export interface GpsPoint {
    point: [number, number];
    timestamp: Date;
}

export interface Zone {
    name: string;
    icon: string | null;
    lat: number;
    lon: number;
    radius: number;
}

// ── Segments ──

export interface StaySegment {
    type: "stay";
    start: Date;
    end: Date;
    durationMs: number;
    center: LatLon;
    radius: number;
    zoneName: string | null;
    zoneIcon: string | null;
    placeName?: string;
    reverseGeocoding?: unknown;
    activityName?: string;
}

export interface MoveSegment {
    type: "move";
    start: Date;
    end: Date;
    durationMs: number;
    distanceM: number;
    points: GpsPoint[];
    activityName?: string;
}

export type Segment = StaySegment | MoveSegment;

// ── State / History ──

export interface NormalizedState {
    state: string | null;
    attributes: Record<string, unknown>;
    ts: Date;
}

export interface Track {
    entityId: string;
    placeEntityId: string | null;
    points: GpsPoint[];
    segments: Segment[];
}

export interface DayData {
    loading: boolean;
    tracks: Track[] | null;
    error: string | null;
}

// ── Card config ──

export interface TimelineCardConfig {
    entity: string | string[];
    places_entity: string | string[];
    activity_entity: string | string[];
    osm_api_key: string | null;
    stay_radius_m: number;
    min_stay_minutes: number;
    map_appearance: "auto" | "light" | "dark";
    map_height_px: number;
    colors: string[];
    distance_unit?: "metric" | "imperial";
    debug: boolean;
    [key: string]: unknown;
}

// ── Home Assistant (minimal) ──

export interface HassLocale {
    language?: string;
    time_format?: string;
    [key: string]: unknown;
}

export interface HassState {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
}

export interface HassLike {
    states: Record<string, HassState>;
    themes?: { darkMode?: boolean; [key: string]: unknown };
    locale?: HassLocale;
    callWS?: (message: Record<string, unknown>) => Promise<unknown>;
    connection?: {
        sendMessagePromise: (message: Record<string, unknown>) => Promise<unknown>;
    };
    [key: string]: unknown;
}
