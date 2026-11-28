import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const modelDirectory = join(root, 'verification');
const models = readdirSync(modelDirectory)
  .filter((name) => name.endsWith('.tla'))
  .toSorted();

interface Repository {
  readonly isFile: (path: string) => boolean;
  readonly read: (path: string) => string;
}

const repository: Repository = {
  isFile: (path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true,
  read: (path) => readFileSync(join(root, path), 'utf8'),
};

const labels = ['Rule', 'Source', 'Tests', 'Mapping', 'Not modeled'];

/**
 * The fields of the header, which is the block of comment lines directly under the module line. A line that starts with
 * a label opens a field, and any other line continues the field above it.
 */
function headerFields(model: string): (readonly [label: string, text: string])[] {
  const fields: [string, string][] = [];
  for (const line of model.split(/\r?\n/u).slice(1)) {
    if (!line.startsWith('\\* ')) break;
    const text = line.slice('\\* '.length);
    const label = labels.find((candidate) => text.startsWith(candidate + ': '));
    const open = fields.at(-1);
    if (label !== undefined) fields.push([label, text.slice(label.length + 2)]);
    else if (open !== undefined) open[1] += ' ' + text;
  }
  return fields;
}

/** What is wrong with the header comment of one model. An empty list means that the header is in order. */
function headerProblems(model: string, { isFile, read }: Repository): string[] {
  const fields = headerFields(model);
  const problems = labels
    .filter((label) => !fields.some(([found]) => found === label))
    .map((label) => 'The header has no ' + label + ': line');
  for (const [label, text] of fields) {
    if (label === 'Tests') {
      for (const path of text.split(', ')) {
        if (!isFile(path)) problems.push('Tests: "' + path + '" is not a file');
      }
    }
    if (label !== 'Source') continue;
    const source = /^(?<path>\S+) \((?<names>[\w.]+(?:, [\w.]+)*)\)$/u.exec(text)?.groups;
    const path = source?.['path'];
    const names = source?.['names'];
    if (path === undefined || names === undefined) {
      problems.push('"Source: ' + text + '" is not "Source: <path> (<name>, <name>)"');
      continue;
    }
    if (!isFile(path)) {
      problems.push('Source: "' + path + '" is not a file');
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

test('reports a path that is not a file, a name the file lacks and a missing line', () => {
  const header = [
    '---- MODULE Example ----',
    '\\* Rule: An example.',
    '\\* Source: src/portable.ts (connectPortable, removedFunction)',
    '\\* Source: src/browserTransport.ts (retire)',
    '\\* Source: src/portable.ts',
    '\\* Source: src (portable)',
    '\\* Tests: test/portable.test.ts, test/removed.test.ts,',
    '\\* test/also-removed.test.ts, test',
    '\\* Mapping: None.',
    'EXTENDS Naturals',
    '\\* Not modeled: This line is below the header.',
  ].join('\n');
  const problems = [
    'The header has no Not modeled: line',
    'Source: src/portable.ts does not contain removedFunction',
    'Source: "src/browserTransport.ts" is not a file',
    '"Source: src/portable.ts" is not "Source: <path> (<name>, <name>)"',
    'Source: "src" is not a file',
    'Tests: "test/removed.test.ts" is not a file',
    'Tests: "test/also-removed.test.ts" is not a file',
    'Tests: "test" is not a file',
  ];
  expect(headerProblems(header, repository)).toEqual(problems);
  // A Windows checkout can give the modules CRLF line ends.
  expect(headerProblems(header.replaceAll('\n', '\r\n'), repository)).toEqual(problems);
});

test('reports an empty Tests line', () => {
  const header = ['---- MODULE Example ----', '\\* Rule: An example.', '\\* Tests: ', '\\* Mapping: None.'].join('\n');
  expect(headerProblems(header, repository)).toEqual([
    'The header has no Source: line',
    'The header has no Not modeled: line',
    'Tests: "" is not a file',
  ]);
});
