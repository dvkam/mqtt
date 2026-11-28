type Reject = (error: Readonly<Error>) => void;
interface WriteTimer {
  readonly expiry: number;
  handle?: ReturnType<typeof setTimeout> | number;
  wake?: (expiry: number) => void;
}

/** Keep one deadline timer for the session's QoS 0 writes. Each write retains its own expiry. */
export class QosZeroWrites {
  private readonly pending = new Map<Reject, number>();
  private readonly timeoutMs: number;
  private readonly onTimeout: () => void;
  private timer?: WriteTimer;
  private stopped?: Error;

  constructor(timeoutMs: number, onTimeout: () => void) {
    this.timeoutMs = timeoutMs;
    this.onTimeout = onTimeout;
  }

  // oxlint-disable-next-line typescript/promise-function-async -- An async method would wrap this promise in a second one for every QoS 0 publish. publish in src/portable.ts awaits the returned promise, and test/bench/packed-qos0.ts measures that path.
  run(write: () => Promise<void>, release: () => void): Promise<void> {
    if (this.stopped) {
      release();
      return Promise.reject(this.stopped);
    }
    return new Promise<void>((resolve, reject) => {
      const wasIdle = this.pending.size === 0;
      const expiry = performance.now() + this.timeoutMs;
      this.pending.set(reject, expiry);
      const timer = this.timer;
      if (timer?.handle === undefined) this.arm(this.timeoutMs, expiry);
      else if (wasIdle) {
        timer.wake = this.wake;
        if (typeof timer.handle === 'object') timer.handle.ref();
      }

      const finish = () => {
        const earliest = this.pending.values().next().value;
        if (earliest !== undefined && earliest <= performance.now()) this.onTimeout();
        release();
        if (!this.pending.delete(reject)) return false;
        if (this.pending.size === 0 && this.timer !== undefined) {
          // An idle timer can be reused. Drop the session reference and let an idle Node process exit.
          this.timer.wake = undefined;
          if (typeof this.timer.handle === 'object') this.timer.handle.unref();
        }
        return true;
      };
      const failed = (reason: unknown) => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the writer's rejection by identity.
        if (finish()) reject(reason);
      };
      try {
        void write().then(() => {
          if (finish()) resolve();
        }, failed);
      } catch (reason) {
        failed(reason);
      }
    });
  }

  retire(reason: Readonly<Error>): void {
    if (this.stopped) return;
    this.stopped = reason;
    clearTimeout(this.timer?.handle);
    this.timer = undefined;
    for (const reject of this.pending.keys()) reject(reason);
    this.pending.clear();
  }

  private arm(delay: number, expiry: number): void {
    const timer: WriteTimer = { expiry, wake: this.wake };
    // The callback reads only `timer`, so a pending idle timer keeps no reference to this object.
    timer.handle = setTimeout(() => {
      const wake = timer.wake;
      timer.handle = undefined;
      timer.wake = undefined;
      wake?.(timer.expiry);
    }, delay);
    this.timer = timer;
  }

  private readonly wake = (expiry: number): void => {
    this.timer = undefined;
    // Every write has the same budget, so insertion order is deadline order.
    const earliest = this.pending.values().next().value;
    if (earliest === undefined) return;
    const remaining = earliest - Math.max(expiry, performance.now());
    if (remaining > 0) this.arm(Math.min(this.timeoutMs, Math.ceil(remaining)), earliest);
    else this.onTimeout();
  };
}
