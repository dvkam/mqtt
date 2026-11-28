import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// A link with this prefix names a file on the default branch, so the test checks it as a repository path.
const hostedPrefix = /^https:\/\/github\.com\/dvkam\/mqtt\/(?:blob|tree)\/main\//;
const fence = /^\s*(?:```|~~~)/;
const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const inlineLink = /\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const referenceDefinition = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)/;

// GitHub's anchor for a heading: lower case, without punctuation, with a hyphen for each space. A repeated heading
// gets a numeric suffix.
function anchors(text: string): ReadonlySet<string> {
  const found = new Set<string>();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (fence.test(line)) fenced = !fenced;
    const title = fenced ? undefined : heading.exec(line)?.[1];
    if (title === undefined) continue;
    const base = title
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replaceAll(' ', '-');
    let anchor = base;
    for (let repeat = 1; found.has(anchor); repeat++) anchor = `${base}-${String(repeat)}`;
    found.add(anchor);
  }
  return found;
}

function targets(text: string): readonly { readonly line: number; readonly target: string }[] {
  const found: { line: number; target: string }[] = [];
  let fenced = false;
  for (const [index, line] of text.split('\n').entries()) {
    if (fence.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const prose = line.replaceAll(/`[^`]*`/g, '');
    for (const match of prose.matchAll(inlineLink)) if (match[1] !== undefined) found.push({ line: index + 1, target: match[1] });
    const definition = referenceDefinition.exec(prose)?.[1];
    if (definition !== undefined) found.push({ line: index + 1, target: definition });
  }
  return found;
}

/**
 * Lists every link in `documents` that points into the repository and does not resolve.
 *
 * @param documents Markdown text by repository path.
 * @param exists Whether a repository path names a file or a directory.
 */
function brokenLinks(documents: Readonly<ReadonlyMap<string, string>>, exists: (path: string) => boolean): readonly string[] {
  const anchorsOf = new Map<string, ReadonlySet<string>>();
  const broken: string[] = [];
  for (const [file, text] of documents) {
    for (const { line, target } of targets(text)) {
      const hosted = hostedPrefix.test(target);
      if (!hosted && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      const [location = '', fragment] = target.replace(hostedPrefix, '').split('#', 2);
      const relative = decodeURIComponent(location.replace(/\?.*$/, ''));
      const path = relative === '' ? file : posix.normalize(hosted ? relative : posix.join(posix.dirname(file), relative));
      const tidy = path.replace(/\/$/, '');
      if (tidy.startsWith('..') || !exists(tidy)) {
        broken.push(`${file}:${String(line)} ${target} names no file`);
        continue;
      }
      const linked = documents.get(tidy);
      if (fragment === undefined || fragment === '' || linked === undefined) continue;
      let known = anchorsOf.get(tidy);
      if (known === undefined) anchorsOf.set(tidy, (known = anchors(linked)));
      if (!known.has(decodeURIComponent(fragment))) broken.push(`${file}:${String(line)} ${target} names no heading`);
    }
  }
  return broken;
}

test('reports a missing file, a missing heading and a path outside the repository', () => {
  const documents = new Map([
    [
      'README.md',
      [
        '# Client `options`',
        '[guide](docs/guide.md#first-step) [source](src/index.ts#L3) [folder](docs/) [web](https://example.com/a.md)',
        '[gone](docs/removed.md) [hosted](https://github.com/dvkam/mqtt/blob/main/docs/removed.md)',
        '[reference]: docs/guide.md#no-such-step',
      ].join('\n'),
    ],
    [
      'docs/guide.md',
      [
        '## First step',
        '## First step',
        '[up](../README.md#client-options) [second](#first-step-1) [third](#first-step-2) [out](../../other.md)',
        '`[code](nowhere.md)`',
        '```md',
        '# Hidden',
        '[fenced](nowhere.md)',
        '```',
        '[hidden](#hidden)',
      ].join('\n'),
    ],
  ]);
  const paths = new Set([...documents.keys(), 'src/index.ts', 'docs']);
  expect(brokenLinks(documents, (path) => paths.has(path))).toEqual([
    'README.md:3 docs/removed.md names no file',
    'README.md:3 https://github.com/dvkam/mqtt/blob/main/docs/removed.md names no file',
    'README.md:4 docs/guide.md#no-such-step names no heading',
    'docs/guide.md:3 #first-step-2 names no heading',
    'docs/guide.md:3 ../../other.md names no file',
    'docs/guide.md:9 #hidden names no heading',
  ]);
});

test('every Markdown link into the repository resolves', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(root, path)));
  const paths = new Set(files);
  for (const path of files)
    for (let folder = posix.dirname(path); folder !== '.'; folder = posix.dirname(folder)) paths.add(folder);
  const documents = new Map(
    files.filter((path) => path.endsWith('.md')).map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );
  expect(documents.has('README.md')).toBe(true);
  expect(brokenLinks(documents, (path) => paths.has(path))).toEqual([]);
});
