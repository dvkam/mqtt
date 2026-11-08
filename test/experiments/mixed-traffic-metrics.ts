import { Socket } from 'node:net';
import { PerformanceObserver, type PerformanceEntry, type PerformanceObserverEntryList } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';

let observing = false;
export function observeProbe(port: number) {
  if (observing) throw new Error('Probe observations must run sequentially');
  let stopped = false;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply forwards the original native receiver and arguments.
  const original = Socket.prototype.write;
  let nativeWriteSamples = 0;
  let nativeObservedPeakBytes = 0;
  const sampleNative = (receiver: unknown) => {
    if (stopped) return;
    if (receiver instanceof Socket && receiver.remotePort === port) {
      nativeWriteSamples++;
      nativeObservedPeakBytes = Math.max(nativeObservedPeakBytes, receiver.writableLength);
    }
  };
  const proxy = new Proxy(original, {
    apply(target, receiver: unknown, argumentsList: readonly unknown[]) {
      sampleNative(receiver);
      try {
        const result: unknown = Reflect.apply(target, receiver, argumentsList);
        return result;
      } finally {
        sampleNative(receiver);
      }
    },
  });
  const start = performance.now();
  let end = Infinity;
  let gcCount = 0;
  let gcTotalMs = 0;
  let gcMaximumMs = 0;
  const recordGc = (entries: readonly Readonly<Pick<PerformanceEntry, 'entryType' | 'startTime' | 'duration'>>[]) => {
    for (const entry of entries)
      if (entry.entryType === 'gc' && entry.startTime >= start && entry.startTime <= end) {
        gcCount++;
        gcTotalMs += entry.duration;
        gcMaximumMs = Math.max(gcMaximumMs, entry.duration);
      }
  };
  const observer = new PerformanceObserver((list: Readonly<Pick<PerformanceObserverEntryList, 'getEntries'>>) => {
    recordGc(list.getEntries());
  });
  const baseline = process.memoryUsage();
  const sampledPeak = { ...baseline };
  let samples = 0;
  const sampleMemory = () => {
    const value = process.memoryUsage();
    samples++;
    sampledPeak.rss = Math.max(sampledPeak.rss, value.rss);
    sampledPeak.heapUsed = Math.max(sampledPeak.heapUsed, value.heapUsed);
    sampledPeak.heapTotal = Math.max(sampledPeak.heapTotal, value.heapTotal);
    sampledPeak.external = Math.max(sampledPeak.external, value.external);
    sampledPeak.arrayBuffers = Math.max(sampledPeak.arrayBuffers, value.arrayBuffers);
    return value;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    observer.observe({ entryTypes: ['gc'] });
    sampleMemory();
    timer = setInterval(() => {
      sampleMemory();
    }, 10);
    timer.unref();
    Socket.prototype.write = proxy;
    observing = true;
  } catch (reason) {
    clearInterval(timer);
    observer.disconnect();
    throw reason;
  }
  return {
    async stop() {
      if (stopped) throw new Error('Probe observation already stopped');
      stopped = true;
      end = performance.now();
      clearInterval(timer);
      const intact = Socket.prototype.write === proxy;
      if (intact) Socket.prototype.write = original;
      observing = false;
      let last: ReturnType<typeof process.memoryUsage>;
      try {
        last = sampleMemory();
        await setImmediate();
        recordGc(observer.takeRecords());
      } finally {
        observer.disconnect();
      }
      if (!intact) throw new Error('Probe native observer changed during run');
      return {
        observationWindowMs: end - start,
        nativeWriteSamples,
        nativeObservedPeakBytes,
        memory: { samples, intervalMs: 10, baseline, sampledPeak, last },
        gc: { count: gcCount, totalMs: gcTotalMs, maximumMs: gcMaximumMs },
      };
    },
  };
}
