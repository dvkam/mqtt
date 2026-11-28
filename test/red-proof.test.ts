import { expect, test } from 'vitest';

test('a deliberately failing test', () => {
  expect(1).toBe(2);
});

export const   deliberatelyUntyped: any = 1;
