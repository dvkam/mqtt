import {
  createBrowserClient,
  createReconnectingClient,
  isMqttError,
  watchPageLifecycle,
  type ReconnectingClient,
} from 'mqtt/browser';

const log: string[] = [];
let client: ReconnectingClient | undefined;
let visibility: 'hidden' | 'visible' | undefined;
let connected = 0;

export async function start(url: string, clientId: string): Promise<void> {
  window.addEventListener('pagehide', (event: Readonly<{ persisted: boolean }>) => {
    log.push(`pagehide persisted=${String(event.persisted)}`);
  });
  window.addEventListener('pageshow', (event: Readonly<{ persisted: boolean }>) => {
    log.push(`pageshow persisted=${String(event.persisted)}`);
  });
  for (const type of ['freeze', 'resume', 'visibilitychange'])
    document.addEventListener(type, () => {
      log.push(`${type} ${document.visibilityState}`);
    });
  const reconnecting = createReconnectingClient(
    createBrowserClient,
    { url, clientId, timeoutMs: 1000 },
    {
      initialDelayMs: 20_000,
      maxDelayMs: 20_000,
      maxAttempts: 5,
      onReconnect(event) {
        if (event.kind === 'connected') {
          connected = event.generation;
          const previous = event.previous?.kind === 'error' ? event.previous : undefined;
          const code = isMqttError(previous?.error) ? previous.error.code : '';
          log.push(`connected ${String(event.generation)} ${code} uncertain=${String(previous?.uncertain?.length ?? 0)}`);
        } else if (event.kind === 'retrying') log.push(`retrying ${String(Math.round(event.delayMs))} ${event.error.message}`);
        else log.push(`stopped ${event.reason}`);
      },
    },
  );
  client = reconnecting;
  watchPageLifecycle(reconnecting, {
    onReturn(event) {
      log.push(`return ${event.trigger} ${event.outcome}`);
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

export async function until(prefix: string, timeoutMs = 5000): Promise<number> {
  const started = performance.now();
  while (!log.some((entry) => entry.startsWith(prefix))) {
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

export async function publishPending(topic: string): Promise<{ code: string; elapsedMs: number }> {
  const session = await client?.session();
  if (session === undefined) throw new Error('Not started');
  const started = performance.now();
  const code = await session.publish(topic, 'pending', { qos: 1 }).then(
    () => 'acknowledged',
    (error: unknown) => (isMqttError(error) ? error.code : String(error)),
  );
  return { code, elapsedMs: performance.now() - started };
}

export async function stop(): Promise<void> {
  await client?.disconnect();
}
