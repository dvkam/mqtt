import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API } from 'typescript/sync';
import { SyntaxKind, type Node } from 'typescript/ast';

// The beta's enum export is untyped. Validate its values before using them.
const kinds: unknown = SyntaxKind;
if (
  typeof kinds !== 'object' ||
  kinds === null ||
  !('AnyKeyword' in kinds) ||
  typeof kinds.AnyKeyword !== 'number' ||
  !('JSDocAllType' in kinds) ||
  typeof kinds.JSDocAllType !== 'number' ||
  !('JSDocNullableType' in kinds) ||
  typeof kinds.JSDocNullableType !== 'number'
)
  throw new Error('The pinned TypeScript AST API does not expose the required syntax kinds');

const anyKeyword = kinds.AnyKeyword;
const wildcard = kinds.JSDocAllType;
const nullable = kinds.JSDocNullableType;
const requested = process.argv.slice(2);
const filenames = (
  requested.length > 0
    ? requested
    : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
        .split('\0')
        .filter(
          (filename) =>
            /\.(?:[cm]?[jt]s|[jt]sx)$/.test(filename) &&
            !filename.startsWith('dist/') &&
            !filename.startsWith('.type-fixtures/') &&
            !filename.split('/').includes('node_modules') &&
            existsSync(filename),
        )
).sort();
const diagnostics: { filename: string; line: number; column: number; code: string; severity: string; message: string }[] = [];
const api = new API({ runExternalCode: false });
try {
  for (const filename of filenames) {
    const lease = api.createSourceFile(resolve(filename), readFileSync(filename, 'utf8'));
    try {
      const source = lease.sourceFile;
      const seen = new Set<Node>();
      const pending: Node[] = [source];
      while (pending.length > 0) {
        const node = pending.pop();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        const kind: unknown = node.kind;
        // Bare JSDoc ? means any; ?string is a specific nullable type.
        if (kind === anyKeyword || kind === wildcard || (kind === nullable && node.getText(source).trim() === '?')) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          diagnostics.push({
            filename,
            line: position.line + 1,
            column: position.character + 1,
            code: 'type-policy(no-any)',
            severity: 'error',
            message: 'Use a specific type instead of any or a JSDoc wildcard.',
          });
        }
        // Token-inclusive children retain JSDoc types omitted by childrenIter in the pinned beta.
        pending.push(...node.getChildren(source), ...(node.jsDoc ?? []));
      }
    } finally {
      lease.dispose();
    }
  }
} finally {
  api.close();
}
process.stdout.write(JSON.stringify({ diagnostics, files: filenames.length }) + '\n');
process.exitCode = diagnostics.length > 0 ? 1 : 0;
