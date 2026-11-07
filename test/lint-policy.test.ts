import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('rejects explicit any types with a failing lint exit code', () => {
  const directory = mkdtempSync(join('test', '.lint-policy-'));
  try {
    const filename = join(directory, 'probe.ts');
    writeFileSync(
      filename,
      'export type Escape = any;\nexport type Items = any[];\nexport const cast = 1 as any;\nexport function result(): any { return 1; }\n',
    );
    const result = spawnSync(
      process.execPath,
      ['node_modules/oxlint/bin/oxlint', '-c', 'oxlint.config.mjs', '--format', 'json', filename],
      { encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const report: unknown = JSON.parse(result.stdout);
    if (typeof report !== 'object' || report === null || !('diagnostics' in report) || !Array.isArray(report.diagnostics))
      throw new Error('Expected Oxlint diagnostics');
    const diagnostics: unknown[] = report.diagnostics;
    const explicitTypes = diagnostics.filter(
      (diagnostic) =>
        typeof diagnostic === 'object' &&
        diagnostic !== null &&
        'code' in diagnostic &&
        diagnostic.code === 'typescript(no-explicit-any)' &&
        'severity' in diagnostic &&
        diagnostic.severity === 'error',
    );
    expect(explicitTypes).toHaveLength(4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
