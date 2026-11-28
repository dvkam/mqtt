export interface LatencySummary {
  count: number;
  minimum: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  maximum: number;
}

export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('Invalid latency samples');
  const sorted = [...samples].sort((first, second) => first - second);
  // The check above proved that there is at least one sample, and every index below is inside the sorted list.
  const at = (index: number): number => {
    const value = sorted[index];
    if (value === undefined) throw new Error('Invalid latency index');
    return value;
  };
  return {
    count: sorted.length,
    minimum: at(0),
    p50: at(Math.ceil(sorted.length * 0.5) - 1),
    p90: at(Math.ceil(sorted.length * 0.9) - 1),
    p95: at(Math.ceil(sorted.length * 0.95) - 1),
    p99: at(Math.ceil(sorted.length * 0.99) - 1),
    maximum: at(sorted.length - 1),
  };
}
