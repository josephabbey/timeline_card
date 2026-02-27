import {endOfDay, startOfDay} from "./utils";
import type {GpsPoint, HassLike, NormalizedState} from "./types";

export async function fetchHistory(hass: HassLike, entityId: string, date: Date): Promise<GpsPoint[]> {
    const states = await fetchEntityHistory(hass, entityId, date);
    return states
        .map((state) => toPoint(state))
        .filter((p): p is GpsPoint => p !== null);
}

export async function fetchEntityHistory(hass: HassLike, entityId: string, date: Date): Promise<NormalizedState[]> {
    if (!hass || !entityId) return [];
    const start = startOfDay(date);
    const end = endOfDay(date);
    const message: Record<string, unknown> = {
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [entityId],
        minimal_response: false,
        no_attributes: false,
        significant_changes_only: false,
    };

    const response = await callWS(hass, message);
    const states = extractEntityStates(response, entityId);
    return states.map((state) => normalizeState(state)).filter((s): s is NormalizedState => s !== null);
}

async function callWS(hass: HassLike, message: Record<string, unknown>): Promise<unknown> {
    if (typeof hass.callWS === "function") {
        return hass.callWS(message);
    }
    if (hass.connection && typeof hass.connection.sendMessagePromise === "function") {
        return hass.connection.sendMessagePromise(message);
    }
    throw new Error("Home Assistant connection not available");
}

function extractEntityStates(response: unknown, entityId: string): Record<string, unknown>[] {
    if (!response) return [];
    if (!Array.isArray(response) && typeof response === "object") {
        const list = (response as Record<string, unknown>)[entityId];
        return Array.isArray(list) ? list as Record<string, unknown>[] : [];
    }
    if (!Array.isArray(response)) return [];
    if (response.length === 0) return [];
    if (Array.isArray(response[0])) {
        return (response[0] || []) as Record<string, unknown>[];
    }
    return (response as Record<string, unknown>[]).filter((state) => state.entity_id === entityId);
}

function normalizeState(state: Record<string, unknown>): NormalizedState | null {
    if (!state) return null;
    const attrs = (state.attributes || state.a || {}) as Record<string, unknown>;
    const tsValue = state.last_changed || state.last_updated || state.created || state.timestamp || state.lu;
    const ts = tsValue ? new Date((tsValue as number) * 1000 || (tsValue as string | number)) : new Date();
    return {
        state: (state.state ?? state.s ?? null) as string | null,
        attributes: attrs,
        ts,
    };
}

function toPoint(state: NormalizedState): GpsPoint | null {
    const attrs = state.attributes || {};
    let lat = Number(attrs.latitude);
    let lon = Number(attrs.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const gps = Array.isArray(attrs.gps) ? attrs.gps : null;
        if (gps && gps.length >= 2) {
            lat = Number(gps[0]);
            lon = Number(gps[1]);
        }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
        point: [lat, lon],
        timestamp: state.ts,
    };
}
