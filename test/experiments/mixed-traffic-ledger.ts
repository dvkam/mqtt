export interface LatencySummary {
  count: number;
  minimum: number;
  p50: number;
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
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1]!,
    maximum: sorted[sorted.length - 1]!,
  };
}
export function probePayload(id: number): string {
  if (!Number.isSafeInteger(id) || id < 0 || id > 99_999_999) throw new Error('Invalid probe identifier');
  return String(id).padStart(8, '0') + 'x'.repeat(248);
}
export interface RoundResult {
  attempted: number;
  accepted: number;
  rejected: number;
  echoed: number;
  checksum: number;
  entryPeak: number;
  echoPeak: number;
  pendingFinal: number;
  sendLatencies: readonly number[];
  echoLatencies: readonly number[];
}
export class ProbeRound {
  private readonly entries = new Map<
    number,
    { payload: string; startedAt: number; outcome: 'pending' | 'accepted' | 'rejected'; echoed: boolean }
  >();
  private readonly expectedAttempts: number;
  private readonly expectedAccepted: number;
  private readonly sendLatencies: number[] = [];
  private readonly echoLatencies: number[] = [];
  private echoPeak = 0;
  private acceptedCount = 0;
  private rejectedCount = 0;
  private echoedCount = 0;
  private pendingEchoes = 0;
  private checksum = 0;
  private closed = false;
  private resolveCompletion!: () => void;
  readonly completion: Promise<void>;
  constructor(expectedAttempts: number, expectedAccepted: number) {
    if (
      !Number.isSafeInteger(expectedAttempts) ||
      expectedAttempts <= 0 ||
      !Number.isSafeInteger(expectedAccepted) ||
      expectedAccepted <= 0 ||
      expectedAccepted > expectedAttempts
    )
      throw new Error('Invalid round limits');
    this.expectedAttempts = expectedAttempts;
    this.expectedAccepted = expectedAccepted;
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }
  attempt(id: number, startedAt: number): string {
    if (
      this.closed ||
      this.entries.has(id) ||
      this.entries.size >= this.expectedAttempts ||
      !Number.isFinite(startedAt) ||
      startedAt < 0
    )
      throw new Error('Invalid probe attempt');
    const payload = probePayload(id);
    this.entries.set(id, { payload, startedAt, outcome: 'pending', echoed: false });
    return payload;
  }
  accepted(id: number, settledAt: number): void {
    const entry = this.entry(id);
    if (entry.outcome !== 'pending') throw new Error('Repeated probe outcome');
    this.sendLatencies.push(this.duration(entry.startedAt, settledAt));
    entry.outcome = 'accepted';
    this.acceptedCount++;
    if (!entry.echoed) this.pendingEchoes++;
    this.checkCompletion();
  }
  rejected(id: number): void {
    const entry = this.entry(id);
    if (entry.outcome !== 'pending' || entry.echoed) throw new Error('Rejected probe identifier was echoed or repeated');
    entry.outcome = 'rejected';
    this.rejectedCount++;
    this.checkCompletion();
  }
  received(payload: string, receivedAt: number): void {
    if (!/^[0-9]{8}/u.test(payload)) throw new Error('Unexpected probe payload');
    const entry = this.entry(Number(payload.slice(0, 8)));
    if (payload !== entry.payload || entry.echoed || entry.outcome === 'rejected') throw new Error('Unexpected probe payload');
    this.echoLatencies.push(this.duration(entry.startedAt, receivedAt));
    entry.echoed = true;
    this.echoedCount++;
    this.checksum += Number(payload.slice(0, 8));
    if (entry.outcome === 'accepted') this.pendingEchoes--;
    this.checkCompletion();
  }
  finish(): RoundResult {
    if (this.closed) throw new Error('Probe round already closed');
    const accepted = this.acceptedCount;
    const rejected = this.rejectedCount;
    if (
      this.entries.size !== this.expectedAttempts ||
      accepted !== this.expectedAccepted ||
      accepted + rejected !== this.expectedAttempts ||
      this.echoedCount !== accepted
    )
      throw new Error('Missing or unsettled probe traffic');
    const result = {
      attempted: this.entries.size,
      accepted,
      rejected,
      echoed: this.echoedCount,
      checksum: this.checksum,
      entryPeak: this.entries.size,
      echoPeak: this.echoPeak,
      pendingFinal: 0,
      sendLatencies: [...this.sendLatencies],
      echoLatencies: [...this.echoLatencies],
    };
    this.entries.clear();
    result.pendingFinal = this.entries.size;
    this.closed = true;
    return result;
  }
  private entry(id: number) {
    const entry = this.entries.get(id);
    if (this.closed || !entry) throw new Error('Unexpected probe identifier');
    return entry;
  }
  private duration(start: number, end: number): number {
    if (!Number.isFinite(end) || end < start) throw new Error('Invalid probe timestamp');
    return end - start;
  }
  private checkCompletion(): void {
    this.echoPeak = Math.max(this.echoPeak, this.pendingEchoes);
    if (this.entries.size !== this.expectedAttempts || this.acceptedCount + this.rejectedCount !== this.expectedAttempts) return;
    if (this.acceptedCount !== this.expectedAccepted) throw new Error('Unexpected accepted count');
    if (this.pendingEchoes === 0) this.resolveCompletion();
  }
}
