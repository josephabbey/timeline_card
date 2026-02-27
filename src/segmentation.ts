import {haversineMeters, toLatLon} from "./utils";
import type {GpsPoint, LatLon, MoveSegment, Segment, StaySegment, Zone} from "./types";

interface SegmentOptions {
    stayRadiusM?: number;
    minStayMinutes?: number;
}

interface Stay {
    startIndex: number;
    endIndex: number;
    start: Date;
    end: Date;
    center: LatLon;
    radius: number;
}

export function segmentTimeline(points: GpsPoint[], options: SegmentOptions, zones: Zone[]): Segment[] {
    if (!Array.isArray(points) || points.length === 0) return [];
    const stayRadius = Math.max(10, options.stayRadiusM || 75);
    const minStayMs = Math.max(1, options.minStayMinutes || 10) * 60000;

    const sorted = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const stays = detectStays(sorted, stayRadius, minStayMs);

    const segments: Segment[] = [];
    let cursor = 0;
    let lastStayEndpoint: GpsPoint | null = null;

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

function detectStays(points: GpsPoint[], stayRadius: number, minStayMs: number): Stay[] {
    const stays: Stay[] = [];
    let i = 0;

    while (i < points.length - 1) {
        const cluster: LatLon[] = [toLatLon(points[i])];
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

        const duration = points[lastInIndex].timestamp.getTime() - points[i].timestamp.getTime();
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

function meanCenter(cluster: LatLon[]): LatLon {
    const sum = cluster.reduce(
        (acc, point) => {
            acc.lat += point.lat;
            acc.lon += point.lon;
            return acc;
        },
        {lat: 0, lon: 0}
    );
    return {
        lat: sum.lat / cluster.length,
        lon: sum.lon / cluster.length,
    };
}

function maxDistance(center: LatLon, cluster: LatLon[]): number {
    let max = 0;
    for (const point of cluster) {
        const distance = haversineMeters(center, point);
        if (distance > max) max = distance;
    }
    return max;
}

function buildStaySegment(stay: Stay, zones: Zone[]): StaySegment {
    const zone = resolveZone(stay.center, zones);
    return {
        type: "stay",
        start: stay.start,
        end: stay.end,
        durationMs: stay.end.getTime() - stay.start.getTime(),
        center: stay.center,
        radius: stay.radius,
        zoneName: zone ? zone.name : null,
        zoneIcon: zone ? zone.icon : null,
    };
}

function buildMoveSegment(points: GpsPoint[], startPoint: GpsPoint | null = null): MoveSegment | null {
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
        durationMs: end.getTime() - start.getTime(),
        distanceM: distance,
        points: startPoint ? [startPoint, ...points] : points,
    };
}

function resolveZone(center: LatLon, zones: Zone[]): Zone | null {
    if (!Array.isArray(zones)) return null;
    let match: Zone | null = null;
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
