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
  return {
    count: sorted.length,
    minimum: sorted[0]!,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1]!,
    maximum: sorted[sorted.length - 1]!,
  };
}
