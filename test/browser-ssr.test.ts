import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('browser entry import and factory construction need no DOM or WebSocket', async () => {
  vi.stubGlobal('WebSocket', undefined);
  vi.stubGlobal('window', undefined);
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('navigator', undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { createBrowserClient } = await import('../src/browser.js');
  const factory = createBrowserClient({ url: 'wss://example.invalid/mqtt', clientId: 'ssr-construction' });
  expect(typeof factory.connect).toBe('function');
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test('factory construction does not invoke the native WebSocket constructor', async () => {
  const constructing = vi.fn<() => never>(() => {
    throw new Error('SSR must not open a socket');
  });
  vi.stubGlobal('WebSocket', constructing);
  const { createBrowserClient } = await import('../src/browser.js');
  const first = createBrowserClient({ url: 'wss://example.invalid', clientId: 'ssr-one' });
  const second = createBrowserClient({ url: 'wss://example.invalid', clientId: 'ssr-two' });
  expect(first).not.toBe(second);
  expect(constructing).not.toHaveBeenCalled();
});
