import { describe, expect, test } from 'vitest';
import { validateTopic } from '../src/util/validateTopic.js';

describe('topic filter wildcards', () => {
  test.each(['#', '+/tennis/#', 'sport/+'])('accepts %s', (filter) => {
    expect(validateTopic(filter)).toBe(true);
  });

  test.each(['', 'sport+', 'sport/#/score'])('rejects %s', (filter) => {
    expect(validateTopic(filter)).toBe(false);
  });
});
