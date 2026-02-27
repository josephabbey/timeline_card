import type {NormalizedState, Segment, StaySegment} from "./types";

const UNKNOWN_LOCATION = "Unknown location";
const LOADING_LOCATION = "Loading address...";
const PERSISTENT_CACHE_KEY = "location_timeline_reverse_geocode_cache_v1";
const MAX_PERSISTENT_CACHE_ENTRIES = 300;

interface ReverseGeocodingConfig {
    nominatim_reverse_url: string;
    request_interval_ms: number;
}

interface QueuedRequest {
    segment: StaySegment;
    segmentKey: string;
    osmApiKey: string;
    onUpdate: () => void;
    retriesLeft: number;
}

interface PersistentCacheEntry {
    placeName: string;
    reverseGeocoding: unknown;
}

interface ResolveStayOptions {
    placeStates?: NormalizedState[];
    date: Date;
    osmApiKey?: string | null;
    onUpdate?: () => void;
}

interface PlaceInterval {
    start: Date;
    end: Date;
    name: string | null;
}

const reverseGeocodingConfig: ReverseGeocodingConfig = {
    nominatim_reverse_url: "https://nominatim.openstreetmap.org/reverse",
    request_interval_ms: 1000,
};
const queuedRequests: QueuedRequest[] = [];
let queuedSegments = new WeakSet<StaySegment>();
let queueRunning = false;
let lastRequestAt = 0;
let queueSession = 0;
const persistentCache: Map<string, PersistentCacheEntry> = loadPersistentCache();


export function clearReverseGeocodingQueue(): void {
    queueSession += 1;

    const callbacks = new Set<() => void>();
    for (const request of queuedRequests) {
        request.segment.placeName = UNKNOWN_LOCATION;
        request.segment.reverseGeocoding = null;
        callbacks.add(request.onUpdate);
    }

    queuedRequests.length = 0;
    queuedSegments = new WeakSet<StaySegment>();

    for (const callback of callbacks) {
        callback();
    }
}

export function resolveStaySegments(segments: Segment[], options: ResolveStayOptions): void {
    const {
        placeStates = [],
        date,
        osmApiKey = null,
        onUpdate = () => {},
    } = options;
    const placeIntervals = placeStates.length
        ? buildPlaceIntervals([...placeStates].sort((a, b) => a.ts.getTime() - b.ts.getTime()), date)
        : [];

    for (const segment of segments) {
        if (segment.type !== "stay" || segment.zoneName) continue;
        if (segment.placeName && segment.placeName !== LOADING_LOCATION) continue;

        const segmentKey = toPersistentCacheKey(segment);
        if (segmentKey) {
            const cached = persistentCache.get(segmentKey);
            if (cached) {
                segment.placeName = cached.placeName;
                segment.reverseGeocoding = {...(cached.reverseGeocoding as object), loadedFromPersistentCache: true};
                continue;
            }
        }

        const placeName = pickPlaceName(placeIntervals, segment.start, segment.end);
        if (placeName) {
            segment.placeName = placeName;
            segment.reverseGeocoding = {source: "places", name: placeName, intervals: placeIntervals};
            if (segmentKey) setPersistentCache(segmentKey, segment.placeName, segment.reverseGeocoding);
            continue;
        }

        if (!osmApiKey) {
            segment.placeName = UNKNOWN_LOCATION;
            segment.reverseGeocoding = null;
            if (segmentKey) setPersistentCache(segmentKey, segment.placeName, segment.reverseGeocoding);
            continue;
        }

        segment.placeName = LOADING_LOCATION;
        segment.reverseGeocoding = null;
        if (segmentKey) enqueueReverseLookup(segment, segmentKey, osmApiKey, onUpdate);
    }
}

function enqueueReverseLookup(segment: StaySegment, segmentKey: string, osmApiKey: string, onUpdate: () => void): void {
    if (queuedSegments.has(segment)) return;
    queuedSegments.add(segment);
    queuedRequests.push({segment, segmentKey, osmApiKey, onUpdate, retriesLeft: 3});
    processQueue();
}

async function processQueue(): Promise<void> {
    if (queueRunning) return;
    queueRunning = true;
    const sessionAtStart = queueSession;

    try {
        while (queuedRequests.length && sessionAtStart === queueSession) {
            const waitMs = reverseGeocodingConfig.request_interval_ms - (Date.now() - lastRequestAt);
            if (waitMs > 0) await sleep(waitMs);

            const request = queuedRequests.shift();
            if (!request) continue;
            lastRequestAt = Date.now();
            await resolveQueuedRequest(request, sessionAtStart);
        }
    } finally {
        queueRunning = false;
    }
}

async function resolveQueuedRequest(request: QueuedRequest, sessionAtStart: number): Promise<void> {
    if (!request) return;
    const {segment, segmentKey, osmApiKey, onUpdate, retriesLeft} = request;
    if (sessionAtStart !== queueSession) return;
    let name = UNKNOWN_LOCATION;
    let result: unknown = null;

    try {
        const url = new URL(reverseGeocodingConfig.nominatim_reverse_url);
        url.searchParams.set("format", "geocodejson");
        url.searchParams.set("lat", String(segment.center.lat));
        url.searchParams.set("lon", String(segment.center.lon));
        url.searchParams.set("email", osmApiKey);

        const response = await fetch(url.toString());

        if (!response.ok) {
            if (retriesLeft > 0) {
                queuedRequests.push({...request, retriesLeft: retriesLeft - 1});
                return;
            }
        } else {
            result = await response.json();
            const features = ((result as Record<string, unknown>)?.features as Array<Record<string, unknown>>)?.[0];
            const geocoding = ((features?.properties as Record<string, unknown>)?.geocoding || {}) as Record<string, string>;
            const houseNumber = geocoding.housenumber ? ` ${geocoding.housenumber}` : "";
            const formatted_address = geocoding.street ? `${geocoding.street}${houseNumber}, ${geocoding.city}` : null;
            const formatted_locality = geocoding.locality ? `${geocoding.locality}, ${geocoding.city}` : null;
            name = geocoding.name || formatted_address || formatted_locality || geocoding.label || UNKNOWN_LOCATION;
        }
    } catch {
        if (retriesLeft > 0) {
            queuedRequests.push({...request, retriesLeft: retriesLeft - 1});
            return;
        }
    }

    if (sessionAtStart !== queueSession) return;

    queuedSegments.delete(segment);
    segment.placeName = name;
    segment.reverseGeocoding = result;
    setPersistentCache(segmentKey, segment.placeName, segment.reverseGeocoding);
    onUpdate();
}

function buildPlaceIntervals(placeStates: NormalizedState[], date: Date): PlaceInterval[] {
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    return placeStates.map((state, index) => {
        const next = placeStates[index + 1];
        const end = next ? next.ts : endOfDay;
        const name = placeDisplayName(state);
        return {
            start: state.ts,
            end,
            name,
        };
    });
}

function placeDisplayName(state: NormalizedState): string | null {
    const attrs = state.attributes || {};
    const street = attrs.street as string | undefined;
    const streetNumber = (attrs.street_number || '') as string;
    const city = attrs.city as string | undefined;
    const formatted_address = street ? `${street} ${streetNumber}, ${city}` : null;
    return (attrs.place_name as string) || formatted_address || state.state || (attrs.formatted_address as string) || null;
}

function pickPlaceName(intervals: PlaceInterval[], start: Date, end: Date): string | null {
    const counts = new Map<string, number>();
    for (const interval of intervals) {
        const overlapMs = Math.min(end.getTime(), interval.end.getTime()) - Math.max(start.getTime(), interval.start.getTime());
        if (overlapMs <= 0 || !interval.name) continue;
        counts.set(interval.name, (counts.get(interval.name) || 0) + overlapMs);
    }

    let best: string | null = null;
    let bestMs = 0;
    for (const [name, ms] of counts.entries()) {
        if (ms > bestMs) {
            best = name;
            bestMs = ms;
        }
    }
    return best;
}


function toPersistentCacheKey(segment: StaySegment): string | null {
    const lat = Number(segment?.center?.lat);
    const lon = Number(segment?.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function loadPersistentCache(): Map<string, PersistentCacheEntry> {
    try {
        const raw = localStorage.getItem(PERSISTENT_CACHE_KEY);
        if (!raw) return new Map();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Map();
        return new Map(parsed as [string, PersistentCacheEntry][]);
    } catch {
        return new Map();
    }
}

function setPersistentCache(key: string, placeName: string, reverseGeocoding: unknown): void {
    if (!key) return;
    persistentCache.set(key, {placeName, reverseGeocoding});

    while (persistentCache.size > MAX_PERSISTENT_CACHE_ENTRIES) {
        const firstKey = persistentCache.keys().next().value;
        if (firstKey === undefined) break;
        persistentCache.delete(firstKey);
    }

    try {
        localStorage.setItem(PERSISTENT_CACHE_KEY, JSON.stringify([...persistentCache.entries()]));
    } catch {
        // ignore storage errors
    }
}

export function clearPersistentCache(): void {
    localStorage.removeItem(PERSISTENT_CACHE_KEY);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
