import {endOfDay, haversineMeters, startOfDay, toLatLon, toPoint} from "./utils.js";
import {resolveStaySegments} from "./reverse-geocoding.js";
import {resolveMoveSegments} from "./activity.js";

export function segmentTimeline(points, config, zones) {
    if (!Array.isArray(points) || points.length === 0) return [];
    const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
    const stays = detectStays(sorted, config);

    const segments = [];
    let cursor = 0;
    let lastStayEndpoint = null;

    stays.forEach((stay) => {
        if (cursor < stay.startIndex) {
            const move = buildMoveSegment(sorted.slice(cursor, stay.startIndex + 1), lastStayEndpoint);
            if (move) segments.push(move);
        }
        segments.push(buildStaySegment(stay, zones));
        cursor = stay.endIndex + 1;
        lastStayEndpoint = sorted[stay.endIndex];
    });

    if (cursor < sorted.length) {
        const move = buildMoveSegment(sorted.slice(cursor), lastStayEndpoint);
        if (move) segments.push(move);
    }
    return segments;
}

function detectStays(points, config) {
    const stayRadius = Math.max(10, config.stay_radius_m || 75);
    const minStayMs = Math.max(1, config.min_stay_minutes || 10) * 60000;

    const stays = [];
    let i = 0;
    while (i < points.length - 1) {
        const cluster = [toLatLon(points[i])];
        let center = toLatLon(points[i]);
        let lastInIndex = i;
        let outlierUsed = false;

        for (let j = i + 1; j < points.length; j += 1) {
            const candidate = toLatLon(points[j]);
            const distance = haversineMeters(center, candidate);
            if (distance <= stayRadius) {
                cluster.push(candidate);
                center = meanCenter(cluster);
                lastInIndex = j;
                outlierUsed = false;
                continue;
            }
            if (!outlierUsed && distance <= stayRadius * 2) {
                outlierUsed = true;
                continue;
            }
            break;
        }

        const duration = points[lastInIndex].timestamp - points[i].timestamp;
        if (duration >= minStayMs) {
            const radius = maxDistance(center, cluster);
            const nextPoint = points[lastInIndex + 1];
            stays.push({
                startIndex: i,
                endIndex: lastInIndex,
                start: points[i].timestamp,
                end: nextPoint ? nextPoint.timestamp : points[lastInIndex].timestamp,
                center,
                radius,
            });
            i = lastInIndex + 1;
        } else {
            i += 1;
        }
    }
    return stays;
}

function meanCenter(cluster) {
    const sum = cluster.reduce(
        (acc, point) => {
            acc.lat += point.lat;
            acc.lon += point.lon;
            return acc;
        },
        {lat: 0, lon: 0},
    );
    return {lat: sum.lat / cluster.length, lon: sum.lon / cluster.length};
}

function maxDistance(center, cluster) {
    let max = 0;
    for (const point of cluster) {
        const distance = haversineMeters(center, point);
        if (distance > max) max = distance;
    }
    return max;
}

function buildStaySegment(stay, zones) {
    const zone = resolveZone(stay.center, zones);
    return {
        type: "stay",
        start: stay.start,
        end: stay.end,
        durationMs: stay.end - stay.start,
        center: stay.center,
        radius: stay.radius,
        zoneName: zone ? zone.name : null,
        zoneIcon: zone ? zone.icon : null,
    };
}

function buildMoveSegment(points, startPoint = null) {
    if (!points || points.length < 2) return null;
    let distance = 0;
    if (startPoint) distance += haversineMeters(toLatLon(startPoint), toLatLon(points[0]));
    for (let i = 1; i < points.length; i += 1) {
        distance += haversineMeters(toLatLon(points[i - 1]), toLatLon(points[i]));
    }
    const start = points[0].timestamp;
    const end = points[points.length - 1].timestamp;
    return {
        type: "move",
        start,
        end,
        durationMs: end - start,
        distanceM: distance,
        points: startPoint ? [startPoint, ...points] : points,
    };
}

function resolveZone(center, zones) {
    if (!Array.isArray(zones)) return null;
    let match = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const zone of zones) {
        const distance = haversineMeters(center, zone);
        if (distance <= zone.radius && distance < bestDistance) {
            match = zone;
            bestDistance = distance;
        }
    }
    return match;
}

function getPlacesEntityMap(entityEntries, config, hass) {
    const map = new Map();

    // Per-entity places_entity from object entries
    for (const entry of entityEntries) {
        if (entry.places_entity && !map.has(entry.entity)) {
            map.set(entry.entity, entry.places_entity);
        }
    }

    // Fallback: top-level places_entity auto-matching by devicetracker_entityid
    const placeEntityIds = Array.isArray(config.places_entity) ? config.places_entity : [];
    const trackedEntities = new Set(entityEntries.map((e) => e.entity));
    placeEntityIds.forEach((placeEntityId) => {
        const trackerEntityId = hass?.states?.[placeEntityId]?.attributes?.devicetracker_entityid;
        if (!trackerEntityId || !trackedEntities.has(trackerEntityId) || map.has(trackerEntityId)) {
            return;
        }
        map.set(trackerEntityId, placeEntityId);
    });

    return map;
}

function getActivityEntityMap(entityEntries) {
    const map = new Map();
    for (const entry of entityEntries) {
        if (entry.activity_entity && !map.has(entry.entity)) {
            map.set(entry.entity, entry.activity_entity);
        }
    }
    return map;
}

function normalizeEntityEntries(config) {
    const value = config.entity;
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    return list
        .map((item) => {
            if (typeof item === "string") {
                const trimmed = item.trim();
                return trimmed ? {entity: trimmed} : null;
            }
            if (item && typeof item === "object" && typeof item.entity === "string") {
                const entity = item.entity.trim();
                if (!entity) return null;
                const entry = {entity};
                if (typeof item.activity_entity === "string" && item.activity_entity.trim()) {
                    entry.activity_entity = item.activity_entity.trim();
                }
                if (typeof item.places_entity === "string" && item.places_entity.trim()) {
                    entry.places_entity = item.places_entity.trim();
                }
                return entry;
            }
            return null;
        })
        .filter(Boolean);
}

function collectZones(hass) {
    if (!hass || !hass.states) return [];
    const states = Object.values(hass.states);
    return states
        .filter((state) => state.entity_id?.startsWith("zone.") && state.attributes?.passive !== true)
        .map((state) => ({
            name: state.attributes?.friendly_name || state.entity_id,
            icon: state.attributes?.icon || null,
            lat: Number(state.attributes?.latitude),
            lon: Number(state.attributes?.longitude),
            radius: Number(state.attributes?.radius) || 100,
        }))
        .filter((zone) => Number.isFinite(zone.lat) && Number.isFinite(zone.lon));
}

async function fetchEntityHistory(hass, entityId, date) {
    if (!hass || !entityId) return [];
    const start = startOfDay(date);
    const end = endOfDay(date);
    const message = {
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [entityId],
        minimal_response: false,
        no_attributes: false,
        significant_changes_only: false,
    };

    const response = await callWS(hass, message);
    return extractEntityStates(response, entityId);
}

async function callWS(hass, message) {
    if (typeof hass.callWS === "function") {
        return hass.callWS(message);
    }
    if (hass.connection && typeof hass.connection.sendMessagePromise === "function") {
        return hass.connection.sendMessagePromise(message);
    }
    throw new Error("Home Assistant connection not available");
}

function extractEntityStates(response, entityId) {
    if (!response) return [];
    if (!Array.isArray(response) && typeof response === "object") {
        const list = response[entityId];
        return Array.isArray(list) ? list : [];
    }
    if (!Array.isArray(response)) return [];
    if (response.length === 0) return [];
    if (Array.isArray(response[0])) {
        return response[0] || [];
    }
    return response.filter((state) => state.entity_id === entityId);
}

export async function getSegmentedTracks(date, config, hass, onQueueUpdate) {
    const entityEntries = normalizeEntityEntries(config);
    const entities = entityEntries.map((e) => e.entity);
    const placesByEntity = getPlacesEntityMap(entityEntries, config, hass);
    const activityByEntity = getActivityEntityMap(entityEntries);
    const zones = collectZones(hass);
    return await Promise.all(
        entities.map(async (entityId) => {
            const rawStates = await fetchEntityHistory(hass, entityId, date);
            const points = rawStates.map((state) => toPoint(state)).filter(Boolean);
            const placeEntityId = placesByEntity.get(entityId) || null;
            const placeStates = placeEntityId ? await fetchEntityHistory(hass, placeEntityId, date) : [];
            const activityEntityId = activityByEntity.get(entityId) || null;
            const activityStates = activityEntityId ? await fetchEntityHistory(hass, activityEntityId, date) : [];
            const segments = segmentTimeline(points, config, zones);
            resolveStaySegments(segments, placeStates, date, config.osm_api_key, onQueueUpdate);
            resolveMoveSegments(segments, activityStates, date);
            return {entityId, placeEntityId, points, segments};
        }),
    );
}
