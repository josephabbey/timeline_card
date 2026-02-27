import type {NormalizedState, Segment} from "./types";

interface ActivityInterval {
    start: Date;
    end: Date;
    name: string | null;
}

export function resolveMoveSegments(segments: Segment[], activityStates: NormalizedState[], date: Date): void {
    if (!activityStates || activityStates.length === 0) return;

    const intervals = buildActivityIntervals(
        [...activityStates].sort((a, b) => a.ts.getTime() - b.ts.getTime()),
        date
    );
    if (intervals.length === 0) return;

    for (const segment of segments) {
        if (segment.type !== "move") continue;
        const name = pickActivityName(intervals, segment.start, segment.end);
        if (name) {
            segment.activityName = name;
        }
    }
}

function buildActivityIntervals(activityStates: NormalizedState[], date: Date): ActivityInterval[] {
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    return activityStates.map((state, index) => {
        const next = activityStates[index + 1];
        const end = next ? next.ts : endOfDay;
        const name = state.state || null;
        return {start: state.ts, end, name};
    });
}

function pickActivityName(intervals: ActivityInterval[], start: Date, end: Date): string | null {
    const counts = new Map<string, number>();
    for (const interval of intervals) {
        const overlapMs = Math.min(end.getTime(), interval.end.getTime()) - Math.max(start.getTime(), interval.start.getTime());
        if (overlapMs <= 0 || !interval.name || ["unknown", "unavailable"].includes(interval.name.toLowerCase())) continue;
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
