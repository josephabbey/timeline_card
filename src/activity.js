import { haversineMeters } from './utils.js';

export function resolveMoveSegments(segments, activityStates, date) {
  if (!activityStates || activityStates.length === 0) return;
  const intervals = buildActivityIntervals(activityStates, date);

  for (const segment of segments) {
    if (segment.type !== 'move') continue;

    let totalPoints = segment.points.length;
    if (totalPoints < 2) continue;

    const bestActivity = pickActivityName(
      intervals,
      segment.start,
      segment.end,
    );
    if (bestActivity) {
      segment.activityName = bestActivity;
    }
  }
}

function buildActivityIntervals(activityStates, date) {
  const endOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  );
  return activityStates.map((state, index) => {
    const next = activityStates[index + 1];
    const end = next ? next.ts : endOfDay;
    let name = state.state;
    return {
      start: state.ts,
      end,
      name,
    };
  });
}

function pickActivityName(intervals, start, end) {
  const counts = new Map();
  for (const interval of intervals) {
    const overlapMs =
      Math.min(end, interval.end) - Math.max(start, interval.start);
    if (overlapMs <= 0 || !interval.name || interval.name === 'unknown')
      continue;
    counts.set(interval.name, (counts.get(interval.name) || 0) + overlapMs);
  }

  let best = null;
  let bestMs = 0;
  for (const [name, ms] of counts.entries()) {
    if (ms > bestMs) {
      best = name;
      bestMs = ms;
    }
  }
  return best;
}
