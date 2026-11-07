import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import configuration from '../oxlint.config.mjs';

test('enables every type-aware rule supplied by the pinned linter', () => {
  const registry: unknown = JSON.parse(
    execFileSync(process.execPath, ['node_modules/oxlint/bin/oxlint', '--rules', '-f', 'json'], { encoding: 'utf8' }),
  );
  if (!Array.isArray(registry)) throw new Error('Expected the Oxlint rule registry');
  const entries: unknown[] = registry;
  const rules: Readonly<Record<string, unknown>> = configuration.rules;
  let typeAwareCount = 0;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !('type_aware' in entry) || entry.type_aware !== true) continue;
    if (!('scope' in entry) || typeof entry.scope !== 'string' || !('value' in entry) || typeof entry.value !== 'string')
      throw new Error('Invalid Oxlint rule metadata');
    expect(rules[entry.scope + '/' + entry.value]).toBe('error');
    typeAwareCount++;
  }
  expect(typeAwareCount).toBeGreaterThan(0);
  expect(configuration.options.typeAware).toBe(true);
});
