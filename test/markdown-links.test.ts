import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// The checker reads inline links, images and reference definitions. It does not read HTML links, Setext headings or a
// target on the line after `](`.

// A link with this prefix names a file on the default branch, so the test checks it as a repository path.
const hostedPrefix = /^https:\/\/github\.com\/dvkam\/mqtt\/(?:blob|tree)\/main\//;
const fence = /^\s*(`{3,}|~{3,})(.*)$/;
const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const inlineLink = /\]\(\s*(?:<([^>]*)>|([^)\s]+))[^)]*\)/g;
const referenceDefinition = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/;

// A fence closes only on a line of the same character that is at least as long as the line that opened it.
function* proseLines(text: string): Generator<readonly [number, string]> {
  let open: string | undefined;
  for (const [index, line] of text.split('\n').entries()) {
    const [, marker, rest = ''] = fence.exec(line) ?? [];
    if (open === undefined) {
      if (marker === undefined) yield [index + 1, line];
      else open = marker;
    } else if (marker !== undefined && marker.startsWith(open) && rest.trim() === '') open = undefined;
  }
}

// GitHub's anchor for a heading: lower case, without punctuation, with a hyphen for each space. A repeated heading
// gets a numeric suffix.
function anchors(text: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const [, line] of proseLines(text)) {
    const title = heading.exec(line)?.[1];
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
  for (const [line, source] of proseLines(text)) {
    const prose = source.replaceAll(/`[^`]*`/g, '');
    const definition = referenceDefinition.exec(prose);
    for (const match of definition === null ? prose.matchAll(inlineLink) : [definition]) {
      const target = match[1] ?? match[2];
      if (target !== undefined) found.push({ line, target });
    }
  }
  return found;
}

// A literal percent sign that starts no escape stays as it is.
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
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
      const [encoded = '', query] = location.split('?', 2);
      const relative = decoded(encoded);
      const path = relative === '' ? file : posix.normalize(hosted ? relative : posix.join(posix.dirname(file), relative));
      const tidy = path.replace(/\/$/, '');
      if (!exists(tidy)) {
        broken.push(`${file}:${String(line)} ${target} names no file`);
        continue;
      }
      const linked = documents.get(tidy);
      // With a query such as `?plain=1` GitHub shows the source, and the fragment names lines of it.
      if (fragment === undefined || fragment === '' || query !== undefined || linked === undefined) continue;
      let known = anchorsOf.get(tidy);
      if (known === undefined) anchorsOf.set(tidy, (known = anchors(linked)));
      if (!known.has(decoded(fragment))) broken.push(`${file}:${String(line)} ${target} names no heading`);
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
        '## See [the guide](docs/guide.md) ##',
        '[guide](docs/guide.md#first-step) [source](src/index.ts#L3) [folder](docs/) [web](https://example.com/a.md)',
        '[plain](docs/guide.md?plain=1#L2) [space](docs/my%20notes.md) [percent](docs/100%.md) [host](//example.com/a.md)',
        '[angle](<docs/my notes.md> "Notes") [self](#see-the-guide)',
        '[gone](docs/removed.md "Removed") [hosted](https://github.com/dvkam/mqtt/blob/main/docs/removed.md)',
        '[reference]: docs/guide.md#no-such-step',
        '[^note]: A footnote is not a link.',
      ].join('\n'),
    ],
    [
      'docs/guide.md',
      [
        '## First step',
        '## First step',
        '[up](../README.md#client-options) [second](#first-step-1) [third](#first-step-2) [out](../../other.md)',
        '[hosted](https://github.com/dvkam/mqtt/blob/main/README.md#client-options) [tree](https://github.com/dvkam/mqtt/tree/main/docs)',
        '[encoded](#first%2Dstep) [samples](https://github.com/dvkam/mqtt/tree/main/samples)',
        '`[code](nowhere.md)`',
        '````md',
        '```',
        '# Hidden',
        '[fenced](nowhere.md)',
        '```',
        '~~~',
        '````',
        '~~~',
        '~~~text',
        '[tilde](nowhere.md)',
        '```',
        '~~~',
        '[hidden](#hidden) [after](docs/guide.md)',
      ].join('\n'),
    ],
  ]);
  const paths = new Set([...documents.keys(), 'src/index.ts', 'docs', 'docs/my notes.md', 'docs/100%.md']);
  expect(brokenLinks(documents, (path) => paths.has(path))).toEqual([
    'README.md:6 docs/removed.md names no file',
    'README.md:6 https://github.com/dvkam/mqtt/blob/main/docs/removed.md names no file',
    'README.md:7 docs/guide.md#no-such-step names no heading',
    'docs/guide.md:3 #first-step-2 names no heading',
    'docs/guide.md:3 ../../other.md names no file',
    'docs/guide.md:5 https://github.com/dvkam/mqtt/tree/main/samples names no file',
    'docs/guide.md:19 #hidden names no heading',
    'docs/guide.md:19 docs/guide.md names no file',
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
