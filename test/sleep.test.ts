import { afterEach, expect, test, vi } from 'vitest';
import { sleep } from '../src/util/sleep.js';

afterEach(() => {
  vi.useRealTimers();
});

test('sleep resolves at its deadline without cancelling the returned handle', async () => {
  vi.useFakeTimers();
  const waiting = sleep(25);
  await vi.advanceTimersByTimeAsync(25);
  await expect(waiting.promise).resolves.toBeUndefined();
  waiting.cancel();
  expect(vi.getTimerCount()).toBe(0);
});

test('sleep cancellation rejects its original promise and removes the timer', async () => {
  vi.useFakeTimers();
  const waiting = sleep(25);
  const promise = waiting.promise;
  const rejected = (async () => {
    await expect(promise).rejects.toThrow('sleep cancelled');
  })();
  waiting.cancel();
  waiting.cancel();
  await rejected;
  expect(waiting.promise).toBe(promise);
  expect(vi.getTimerCount()).toBe(0);
});
