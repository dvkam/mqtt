import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The main ruleset requires these three statuses. GitHub counts a skipped required job as passing, and a job-level `if`
// or a `needs` on a job that did not pass is what skips a job.
const requiredChecks = ['checks (ubuntu-26.04)', 'checks (windows-latest)', 'packed-consumer'];

const jobHeader = /^ {2}([\w-]+):\s*$/;
const jobKey = /^ {4}([\w-]+):\s*(.*)$/;

// Reads the keys directly under each job. It relies on the two-space indentation of ci.yml and is not a YAML parser.
function jobs(workflow: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const found = new Map<string, Map<string, string>>();
  let inJobs = false;
  let current: Map<string, string> | undefined;
  for (const line of workflow.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inJobs = line.startsWith('jobs:');
      current = undefined;
      continue;
    }
    if (!inJobs) continue;
    const id = jobHeader.exec(line)?.[1];
    if (id !== undefined) {
      current = new Map();
      found.set(id, current);
      continue;
    }
    const [, key, value] = jobKey.exec(line) ?? [];
    if (key !== undefined && value !== undefined) current?.set(key, value);
  }
  return found;
}

// Lists, for each job that reports under the status name, the keys that let GitHub skip it.
function skippingKeys(workflow: string, status: string): string[][] {
  const found: string[][] = [];
  for (const [id, keys] of jobs(workflow)) {
    if ((keys.get('name') ?? id) !== status) continue;
    found.push([...keys.keys()].filter((key) => key === 'if' || key === 'needs'));
  }
  return found;
}

test('the reader finds a job-level if and needs and ignores those of a step', () => {
  const workflow = [
    'on:',
    '  push:',
    'jobs:',
    '  # A comment between jobs.',
    '  guarded:',
    '    name: checks (ubuntu-26.04)',
    '    needs: other',
    '    if: ${{ always() }}',
    '    steps:',
    '      - run: true',
    '        if: ${{ failure() }}',
    '  packed-consumer:',
    '    steps:',
    '      - if: ${{ failure() }}',
    '        run: true',
  ].join('\r\n');

  expect(skippingKeys(workflow, 'checks (ubuntu-26.04)')).toEqual([['needs', 'if']]);
  expect(skippingKeys(workflow, 'packed-consumer')).toEqual([[]]);
  expect(skippingKeys(workflow, 'checks (windows-latest)')).toEqual([]);
});

test.each(requiredChecks)('exactly one job reports as %s, and it has no job-level if and no needs', (status) => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

  expect(skippingKeys(workflow, status)).toEqual([[]]);
});
