import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function lintFixture(contents: string, extension: 'ts' | 'mjs', configuration = 'compiler') {
  const directory = mkdtempSync(join(tmpdir(), 'mqtt-lint-policy-'));
  try {
    if (configuration === 'repository') {
      execFileSync('git', ['init', '--quiet'], { cwd: directory });
      mkdirSync(join(directory, 'verification', '.lint-policy'), { recursive: true });
    }
    const filename = join(directory, configuration === 'repository' ? 'verification/.lint-policy' : '', `probe.${extension}`);
    writeFileSync(filename, contents);
    const result = spawnSync(
      process.execPath,
      configuration === 'compiler' || configuration === 'repository' || configuration === 'default-policy'
        ? [resolve('lint/typePolicy.ts'), ...(configuration === 'compiler' ? [filename] : [])]
        : configuration === 'discovery'
          ? [
              'node_modules/oxlint/bin/oxlint',
              '-c',
              'oxlint.config.mjs',
              '--format',
              'json',
              '--debug',
              'files',
              'src',
              'test',
              'sample',
              'lint',
              'verification',
            ]
          : ['node_modules/oxlint/bin/oxlint', '-c', configuration, '--format', 'json', filename],
      { cwd: configuration === 'repository' ? directory : process.cwd(), encoding: 'utf8', timeout: 15000 },
    );
    if (result.error) throw result.error;
    if (configuration === 'discovery') {
      return {
        status: result.status,
        diagnostics: [],
        files: result.stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((filename) => resolve(filename)),
        fixture: filename,
      };
    }
    const report: unknown = JSON.parse(result.stdout);
    if (typeof report !== 'object' || report === null || !('diagnostics' in report) || !Array.isArray(report.diagnostics))
      throw new Error('Expected Oxlint diagnostics');
    const diagnostics: unknown[] = report.diagnostics;
    return { status: result.status, diagnostics, files: [], fixture: filename };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function errorsFor(diagnostics: readonly unknown[], code: string) {
  return diagnostics.filter(
    (diagnostic) =>
      typeof diagnostic === 'object' &&
      diagnostic !== null &&
      'code' in diagnostic &&
      diagnostic.code === code &&
      'severity' in diagnostic &&
      diagnostic.severity === 'error',
  );
}

test.each(['oxlint.config.mjs', 'compiler'])('rejects explicit any through %s', (configuration) => {
  const result = lintFixture(
    'export type Escape = any;\nexport type Items = any[];\nexport const cast = 1 as any;\nexport function result(): any { return 1; }\n',
    'ts',
    configuration,
  );
  expect(result.status).toBe(1);
  expect(
    errorsFor(result.diagnostics, configuration === 'compiler' ? 'type-policy(no-any)' : 'typescript(no-explicit-any)'),
  ).toHaveLength(4);
});

test('an active negative fixture does not enter Oxlint file discovery', () => {
  const result = lintFixture('export type InvalidFixture = any;', 'ts', 'discovery');
  expect(result.status).toBe(0);
  expect(result.files).toContain(resolve('test/lint-policy.test.ts'));
  expect(result.files).not.toContain(resolve(result.fixture));
});

test('an active negative fixture does not enter default policy discovery', () => {
  const result = lintFixture('export type InvalidFixture = any;', 'ts', 'default-policy');
  expect(result.status).toBe(0);
  expect(result.diagnostics).toEqual([]);
});

test.each(['compiler'])('rejects literal and nested JSDoc escapes through %s', (configuration) => {
  const result = lintFixture(
    '/** @type {any} */ export const direct = 1;\n' +
      '/** @type {*} */ export const wildcard = 1;\n' +
      '/** @type {Promise<any>} */ export const nested = Promise.resolve(1);\n' +
      '/** @type {Array<*>} */ export const nestedWildcard = [];\n',
    'mjs',
    configuration,
  );
  expect(result.status).toBe(1);
  expect(errorsFor(result.diagnostics, 'type-policy(no-any)')).toHaveLength(4);
});

test('rejects inline, braceless and multi-star JSDoc annotations', () => {
  const result = lintFixture(
    [
      '/** @param {string} name @returns {any} */ export function inline(name) { return name; }',
      '/** @type {string} @type {any} */ export const repeated = 1;',
      '/** @type any */ export const direct = 1;',
      '/** @type Array<any> */ export const array = [];',
      '/** @type * */ export const wildcard = 1;',
      '/** @satisfies any */ export const checked = 1;',
      '/*** @type {any} */ export const stars = 1;',
    ].join('\n'),
    'mjs',
  );
  expect(result.status).toBe(1);
  expect(errorsFor(result.diagnostics, 'type-policy(no-any)')).toHaveLength(7);
});

test('rejects JSDoc question-mark any without rejecting nullable specific types', () => {
  const rejected = lintFixture(
    '/** @type {?} */ export const direct = 1;\n/** @type {Array<?>} */ export const nested = [];',
    'mjs',
  );
  expect(rejected.status).toBe(1);
  expect(errorsFor(rejected.diagnostics, 'type-policy(no-any)')).toHaveLength(2);
  const accepted = lintFixture(
    '/** @type {?string} */ export const nullable = null;\n/** @type {unknown} */ export const value = 1;',
    'mjs',
  );
  expect(accepted.status).toBe(0);
  expect(accepted.diagnostics).toEqual([]);
});

test('checks ambient module import attributes with the same compiler grammar', () => {
  const result = lintFixture('declare module "*.wire" with {type: "bytes"} { const bytes: any; export default bytes; }', 'ts');
  expect(result.status).toBe(1);
  expect(errorsFor(result.diagnostics, 'type-policy(no-any)')).toHaveLength(1);
});

test('the default policy scan includes verification scripts', () => {
  const result = lintFixture('/** @type {any} */ export const value = 1;', 'mjs', 'repository');
  expect(result.status).toBe(1);
  expect(errorsFor(result.diagnostics, 'type-policy(no-any)')).toHaveLength(1);
});

test('rejects aliases, constraints, defaults and nested JSDoc signatures', () => {
  const result = lintFixture(
    [
      '/** @type {unknown | any} */ export const union = 1;',
      '/** @returns {Promise<*>} */ export function promise() { return Promise.resolve(1); }',
      '/**\n * @typedef {object} Records\n * @property {Array<*>} values\n */',
      '/** @typedef {{ payload: any }} Message */',
      '/** @template {any} Value */',
      '/** @template [Value=any] */',
      '/** @satisfies {any} */ export const checked = 1;',
      '/** @arg {*} value */ export function alias(value) { return value; }',
      '/** @type {string extends string ? any : never} */ export const conditional = 1;',
    ].join('\n'),
    'mjs',
  );
  expect(result.status).toBe(1);
  expect(errorsFor(result.diagnostics, 'type-policy(no-any)')).toHaveLength(9);
});

test('rejects compiler-recognized any nodes even in malformed annotations', () => {
  const result = lintFixture(
    '/** @template [Value=any */\nexport function generic(value) { return value; }\n/** @type {any */ export const brokenBrace = 1;\n',
    'mjs',
  );
  expect(result.status).toBe(1);
  expect(errorsFor(result.diagnostics, 'type-policy(no-any)')).toHaveLength(2);
});

test.each(['oxlint.config.mjs', 'compiler'])('accepts specific types and non-type any text through %s', (configuration) => {
  const result = lintFixture(
    [
      '// English text may mention any value.',
      "export const description = '/** @type {any} */';",
      '/** @type {readonly string[]} */ export const names = [];',
      '/** @type {{any: string; many: number}} */ export const fields = {any: "value", many: 1};',
      '/** @type {"any"} */ export const literal = "any";',
      '/** @type {Record<string, import("node:events").EventEmitter>} */ export const imported = {};',
      '/** @template [Value=string] */',
      '/** @example {any} is documentation, not a type annotation. */',
      'export const signal = AbortSignal.any([]);',
    ].join('\n'),
    'mjs',
    configuration,
  );
  expect(result.status).toBe(0);
  expect(result.diagnostics).toEqual([]);
});
