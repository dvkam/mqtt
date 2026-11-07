import { createBrowserClient } from 'mqtt/browser';

export function inspectFactory() {
  const first = createBrowserClient({ url: 'wss://example.invalid/mqtt', clientId: 'ssr-first' });
  const second = createBrowserClient({ url: 'wss://example.invalid/mqtt', clientId: 'ssr-second' });
  return { connectType: typeof first.connect, distinctFactories: first !== second };
}
