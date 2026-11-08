import { describe, expect, test } from 'vitest';
import { validateTopic, validateTopics } from '../src/util/validateTopic.js';

describe('topic filter wildcards', () => {
  test.each(['#', '+/tennis/#', 'sport/+'])('accepts %s', (filter) => {
    expect(validateTopic(filter)).toBe(true);
  });

  test.each(['', 'sport+', 'sport/#/score'])('rejects %s', (filter) => {
    expect(validateTopic(filter)).toBe(false);
  });
});

describe('MQTT topic filter strings', () => {
  test.each([
    ['NUL', 'a\u0000b'],
    ['lone high surrogate', '\uD800'],
    ['lone low surrogate', '\uDC00'],
    ['unpaired high surrogate before text', '\uD800a'],
    ['ASCII above the byte limit', 'a'.repeat(65_536)],
    ['multibyte text above the byte limit', 'é'.repeat(32_768)],
    ['astral text above the byte limit', '😀'.repeat(16_384)],
  ])('rejects %s', (_name, filter) => {
    expect(validateTopic(filter)).toBe(false);
  });

  test.each([
    ['ASCII at the byte limit', 'a'.repeat(65_535)],
    ['multibyte text at the byte limit', 'é'.repeat(32_767) + 'a'],
    ['astral text at the byte limit', '😀'.repeat(16_383) + 'abc'],
    ['valid surrogate pair', 'a😀/+/b/#'],
    ['UTF-8 byte-order mark as topic text', '\uFEFFtopic'],
    ['root separator', '/'],
  ])('accepts %s', (_name, filter) => {
    expect(validateTopic(filter)).toBe(true);
  });

  test('array validation reports the first invalid original filter without changing the input', () => {
    const filters = Object.freeze(['valid/+', 'a\u0000b', 'later/#']);
    expect(validateTopics(filters)).toBe('a\u0000b');
    expect(filters).toEqual(['valid/+', 'a\u0000b', 'later/#']);
    expect(validateTopics(['é'.repeat(32_767) + 'a'])).toBeNull();
    expect(validateTopics([])).toBe('empty_topic_list');
  });
});
