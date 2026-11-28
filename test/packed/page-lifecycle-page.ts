import {
  createBrowserClient,
  createReconnectingClient,
  isMqttError,
  watchPageLifecycle,
  type ReconnectingClient,
} from 'mqtt/browser';

/** The retry policy of the page's client. The defaults keep the retry timer pending for the whole check. */
export interface Retry {
  readonly delayMs: number;
  readonly maxAttempts: number;
}

const log: string[] = [];
const times: number[] = [];
let client: ReconnectingClient | undefined;
let visibility: 'hidden' | 'visible' | undefined;
let connected = 0;
let listening = false;
let pending: Readonly<{ code: string; elapsedMs: number }> | undefined;

function record(entry: string): void {
  log.push(entry);
  times.push(performance.now());
  // The console carries each entry to the test, also from a page that the browser unloads.
  console.info(`lifecycle ${entry}`);
}

export function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('pagehide', (event: Readonly<{ persisted: boolean }>) => {
    record(`pagehide persisted=${String(event.persisted)}`);
  });
  window.addEventListener('pageshow', (event: Readonly<{ persisted: boolean }>) => {
    record(`pageshow persisted=${String(event.persisted)}`);
  });
  for (const type of ['freeze', 'resume', 'visibilitychange'])
    document.addEventListener(type, () => {
      record(`${type} ${document.visibilityState}`);
    });
}

export async function start(
  url: string,
  clientId: string,
  retry: Readonly<Retry> = { delayMs: 20_000, maxAttempts: 5 },
): Promise<void> {
  listen();
  const reconnecting = createReconnectingClient(
    createBrowserClient,
    { url, clientId, timeoutMs: 1000 },
    {
      initialDelayMs: retry.delayMs,
      maxDelayMs: retry.delayMs,
      maxAttempts: retry.maxAttempts,
      onReconnect(event) {
        if (event.kind === 'connected') {
          connected = event.generation;
          const previous = event.previous?.kind === 'error' ? event.previous : undefined;
          const code = isMqttError(previous?.error) ? previous.error.code : '';
          record(`connected ${String(event.generation)} ${code} uncertain=${String(previous?.uncertain?.length ?? 0)}`);
        } else if (event.kind === 'retrying') record(`retrying ${String(Math.round(event.delayMs))} ${event.error.message}`);
        else if (event.kind === 'stopped') record(`stopped ${event.reason}`);
      },
    },
  );
  client = reconnecting;
  watchPageLifecycle(reconnecting, {
    onReturn(event) {
      record(`return ${event.trigger} ${event.outcome}`);
    },
  });
  await reconnecting.session();
}

export function generation(): number {
  return connected;
}

export function entries(): string[] {
  return [...log];
}

export function timeline(): string[] {
  return log.map((entry, index) => `${String(Math.round(times[index] ?? 0))} ${entry}`);
}

/** Waits for an entry that starts with `prefix`, at index `from` or later, and returns the milliseconds it waited. */
export async function until(prefix: string, timeoutMs = 5000, from = 0): Promise<number> {
  const started = performance.now();
  while (!log.slice(from).some((entry) => entry.startsWith(prefix))) {
    if (performance.now() - started > timeoutMs) throw new Error(`No "${prefix}" in ${JSON.stringify(log)}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return performance.now() - started;
}

// A headless page stays visible, so the getter of document.visibilityState is replaced on this document.
export function setVisibility(state: 'hidden' | 'visible'): void {
  if (visibility === undefined) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

export function dispatchRestore(): void {
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
}

export async function publishPending(topic: string): Promise<Readonly<{ code: string; elapsedMs: number }>> {
  const session = await client?.session();
  if (session === undefined) throw new Error('Not started');
  const started = performance.now();
  const code = await session.publish(topic, 'pending', { qos: 1 }).then(
    () => 'acknowledged',
    (error: unknown) => (isMqttError(error) ? error.code : String(error)),
  );
  return { code, elapsedMs: performance.now() - started };
}

/** Starts a QoS 1 publication and returns at once, so the test can freeze the page while the publication is pending. */
export async function startPublish(topic: string): Promise<void> {
  const session = await client?.session();
  if (session === undefined) throw new Error('Not started');
  pending = undefined;
  void publishPending(topic).then((result) => {
    pending = result;
  });
}

export function published(): Readonly<{ code: string; elapsedMs: number }> | undefined {
  return pending;
}

/** Runs `count` timers of `delayMs` one after another and returns the elapsed milliseconds, which shows timer throttling. */
export async function timerChain(count: number, delayMs: number): Promise<number> {
  const started = performance.now();
  for (let index = 0; index < count; index++)
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  return performance.now() - started;
}

export async function stop(): Promise<void> {
  await client?.disconnect();
}
