import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const modelDirectory = join(root, 'verification');
const models = readdirSync(modelDirectory)
  .filter((name) => name.endsWith('.tla'))
  .toSorted();

interface Repository {
  readonly exists: (path: string) => boolean;
  readonly read: (path: string) => string;
}

const repository: Repository = {
  exists: (path) => existsSync(join(root, path)),
  read: (path) => readFileSync(join(root, path), 'utf8'),
};

/** What is wrong with the header comment of one model. An empty list means that the header is in order. */
function headerProblems(model: string, { exists, read }: Repository): string[] {
  const lines = model.split('\n').filter((line) => line.startsWith('\\* '));
  const problems = ['Rule:', 'Source:', 'Tests:', 'Mapping:', 'Not modeled:']
    .filter((label) => !lines.some((line) => line.startsWith('\\* ' + label + ' ')))
    .map((label) => 'The header has no ' + label + ' line');
  for (const line of lines) {
    if (line.startsWith('\\* Tests: ')) {
      for (const path of line.slice('\\* Tests: '.length).split(', ')) {
        if (!exists(path)) problems.push('Tests: ' + path + ' does not exist');
      }
    }
    if (!line.startsWith('\\* Source: ')) continue;
    const source = /^\\\* Source: (?<path>\S+) \((?<names>[\w.]+(?:, [\w.]+)*)\)$/u.exec(line)?.groups;
    const path = source?.['path'];
    const names = source?.['names'];
    if (path === undefined || names === undefined) {
      problems.push('"' + line + '" is not "Source: <path> (<name>, <name>)"');
      continue;
    }
    if (!exists(path)) {
      problems.push('Source: ' + path + ' does not exist');
      continue;
    }
    const words = new Set(read(path).match(/\w+/gu));
    for (const name of names.split(', ')) {
      if (!name.split('.').every((part) => words.has(part))) problems.push('Source: ' + path + ' does not contain ' + name);
    }
  }
  return problems;
}

test.each(models)('the header of %s names source and test files that exist', (name) => {
  expect(headerProblems(readFileSync(join(modelDirectory, name), 'utf8'), repository)).toEqual([]);
});

test('reports a path that does not exist, a name the file lacks and a missing line', () => {
  const header = [
    '---- MODULE Example ----',
    '\\* Rule: An example.',
    '\\* Source: src/portable.ts (connectPortable, removedFunction)',
    '\\* Source: src/browserTransport.ts (retire)',
    '\\* Source: src/portable.ts',
    '\\* Tests: test/portable.test.ts, test/removed.test.ts',
    '\\* Mapping: None.',
  ].join('\n');
  expect(headerProblems(header, repository)).toEqual([
    'The header has no Not modeled: line',
    'Source: src/portable.ts does not contain removedFunction',
    'Source: src/browserTransport.ts does not exist',
    '"\\* Source: src/portable.ts" is not "Source: <path> (<name>, <name>)"',
    'Tests: test/removed.test.ts does not exist',
  ]);
});
