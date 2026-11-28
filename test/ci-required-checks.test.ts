import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The main ruleset requires these three statuses. GitHub counts a skipped required job as passing, and a job-level `if`
// or a `needs` on a job that did not pass is what skips a job.
const platformChecks = ['checks (ubuntu-26.04)', 'checks (windows-latest)'];
const requiredChecks = [...platformChecks, 'packed-consumer'];

// Each platform job runs these checks as steps. The second entry is the step id that a report job reads.
const checkSteps: readonly (readonly [name: string, id: string])[] = [
  ['test', 'test'],
  ['test:types', 'test-types'],
  ['lint', 'lint'],
  ['format:check', 'format-check'],
  ['build', 'build'],
];
const checkNames: readonly string[] = checkSteps.map(([name]) => name);

const jobHeader = /^ {2}([\w-]+):\s*$/;
const jobKey = /^ {4}(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*:\s*(.*)$/;
const stepKey = /^ {6}(?:- | {2})([\w-]+):\s*(.*)$/;
const reportEntry = /^\s+- \{ check: '?([^,']+)'?, step: ([\w-]+) \}\s*$/;

interface Job {
  readonly keys: ReadonlyMap<string, string>;
  readonly lines: readonly string[];
}

// Reads the jobs with the keys directly under each and the lines below it. It relies on the two-space indentation of
// ci.yml and is not a YAML parser. It reads a quoted key as the key it names.
function jobs(workflow: string): ReadonlyMap<string, Job> {
  const found = new Map<string, Job>();
  let inJobs = false;
  let keys: Map<string, string> | undefined;
  let lines: string[] | undefined;
  for (const line of workflow.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inJobs = line.startsWith('jobs:');
      keys = undefined;
      lines = undefined;
      continue;
    }
    if (!inJobs) continue;
    const id = jobHeader.exec(line)?.[1];
    if (id !== undefined) {
      keys = new Map();
      lines = [];
      found.set(id, { keys, lines });
      continue;
    }
    lines?.push(line);
    const [, doubleQuoted, singleQuoted, plain, value] = jobKey.exec(line) ?? [];
    const key = doubleQuoted ?? singleQuoted ?? plain;
    if (key !== undefined && value !== undefined) keys?.set(key, value);
  }
  return found;
}

function jobsReporting(workflow: string, status: string): Job[] {
  const found: Job[] = [];
  for (const [id, job] of jobs(workflow)) {
    if ((job.keys.get('name') ?? id) === status) found.push(job);
  }
  return found;
}

// Lists, for each job that reports under the status name, the keys that let GitHub skip it. It does not guard the
// steps. A step-level `if` is how a check step waits for the install.
function skippingKeys(workflow: string, status: string): string[][] {
  const found: string[][] = [];
  for (const job of jobsReporting(workflow, status)) {
    found.push([...job.keys.keys()].filter((key) => key === 'if' || key === 'needs'));
  }
  return found;
}

// Returns the lines of the job whose steps carry the anchor.
function anchoredLines(workflow: string, anchor: string): readonly string[] {
  for (const job of jobs(workflow).values()) {
    if (job.keys.get('steps') === `&${anchor}`) return job.lines;
  }
  return [];
}

// Lists the name, the id and the `continue-on-error` value of each check step, for each job that reports under the
// status name. A job that takes its steps from an anchor of another job gets the steps of that job.
function checkStepsOf(workflow: string, status: string): (string | undefined)[][][] {
  const found: (string | undefined)[][][] = [];
  for (const job of jobsReporting(workflow, status)) {
    const steps: Map<string, string>[] = [];
    const alias = /^\*([\w-]+)$/.exec(job.keys.get('steps') ?? '')?.[1];
    for (const line of alias === undefined ? job.lines : anchoredLines(workflow, alias)) {
      const [, key, value] = stepKey.exec(line) ?? [];
      if (line.startsWith('      - ')) steps.push(new Map());
      if (key !== undefined && value !== undefined) steps.at(-1)?.set(key, value);
    }
    const checks: (string | undefined)[][] = [];
    for (const step of steps) {
      const name = step.get('name');
      if (name !== undefined && checkNames.includes(name)) {
        checks.push([name, step.get('id'), step.get('continue-on-error')]);
      }
    }
    found.push(checks);
  }
  return found;
}

function reportEntries(workflow: string): readonly (readonly [check: string, step: string])[] {
  const found: (readonly [string, string])[] = [];
  for (const line of workflow.split(/\r?\n/)) {
    const [, check, step] = reportEntry.exec(line) ?? [];
    if (check !== undefined && step !== undefined) found.push([check, step]);
  }
  return found;
}

const sample = [
  'on:',
  '  push:',
  'jobs:',
  '  # A comment between jobs.',
  '  guarded:',
  '    name: checks (ubuntu-26.04)',
  '    needs: other',
  '    "if": ${{ always() }}',
  '    steps: &shared',
  '      - uses: actions/checkout@v7',
  '      - name: test',
  '        id: test',
  '        if: ${{ failure() }}',
  '        run: pnpm test',
  '      - name: lint',
  '        continue-on-error: true',
  '        run: pnpm lint',
  '  aliased:',
  '    name: checks (windows-latest)',
  "    'needs': guarded",
  '    steps: *shared',
  '  report:',
  '    strategy:',
  '      matrix:',
  '        include:',
  '          - { check: test, step: test }',
  "          - { check: 'test:types', step: test-types }",
  '  packed-consumer:',
  '    steps:',
  '      - if: ${{ failure() }}',
  '        run: true',
].join('\r\n');

test('the reader finds a plain or quoted job-level if and needs and ignores those of a step', () => {
  expect(skippingKeys(sample, 'checks (ubuntu-26.04)')).toEqual([['needs', 'if']]);
  expect(skippingKeys(sample, 'checks (windows-latest)')).toEqual([['needs']]);
  expect(skippingKeys(sample, 'packed-consumer')).toEqual([[]]);
  expect(skippingKeys(sample, 'checks (macos-latest)')).toEqual([]);
});

test('the reader finds the check steps of a job, also through an anchor, and the report entries', () => {
  const steps = [
    ['test', 'test', undefined],
    ['lint', undefined, 'true'],
  ];

  expect(checkStepsOf(sample, 'checks (ubuntu-26.04)')).toEqual([steps]);
  expect(checkStepsOf(sample, 'checks (windows-latest)')).toEqual([steps]);
  expect(checkStepsOf(sample, 'packed-consumer')).toEqual([[]]);
  expect(reportEntries(sample)).toEqual([
    ['test', 'test'],
    ['test:types', 'test-types'],
  ]);
});

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test.each(requiredChecks)('exactly one job reports as %s, and it has no job-level if and no needs', (status) => {
  expect(skippingKeys(workflow, status)).toEqual([[]]);
});

test.each(platformChecks)('%s runs the five checks, and none continues on error', (status) => {
  expect(checkStepsOf(workflow, status)).toEqual([checkSteps.map(([name, id]) => [name, id, undefined])]);
});

// A report job is named after its matrix entry and its platform. An entry named `checks` would report under a required
// status name.
test('the report jobs report the five checks and never under a required status name', () => {
  const entries = reportEntries(workflow);

  expect(entries.map(([check]) => check)).not.toContain('checks');
  expect(entries).toEqual(checkSteps);
});
