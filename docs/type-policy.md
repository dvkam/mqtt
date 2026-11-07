# Type policy

`pnpm lint` runs the strict Oxlint checks and a repository-wide no-any check. `pnpm lint:policy` runs the latter alone. The policy uses the AST API supplied by the pinned TypeScript 7.1 beta. It adds no dependency and uses the same syntax parser as the compiler.

The default scan includes tracked TypeScript and JavaScript files and new files that Git does not ignore. It covers source, tests, samples, tooling, verification scripts and code in hidden directories. Installed dependencies and generated `dist` and `.type-fixtures` output are excluded. Deleted files are skipped. Development and CI need Git available.

The check rejects TypeScript AnyKeyword and JSDoc wildcard nodes, including the bare question-mark spelling that TypeScript treats as any. Specific nullable types such as `?string` remain accepted. It visits attached JSDoc as well as ordinary syntax children, with each node visited once. This covers nested types, inline tags, braceless annotations, multi-star comments, aliases, template constraints/defaults and ambient module import attributes. Each diagnostic includes its file, line and column, and any finding causes exit code 1.

Quoted string types, object property names, prose, examples and string contents do not become any-type nodes. Syntax validity remains the compiler's responsibility. The policy can reject any nodes recovered from a malformed annotation, but it is not a separate JSDoc validity checker.

## Tool lifecycle

The check owns one native compiler API session. It disposes each parsed source lease before reading the next file and closes the session in finally. External content mapper execution is disabled. A missing file, unsupported API or failed parser request fails the command instead of reporting a clean scan.

The beta currently exposes untyped syntax-kind enum declarations. The checker receives those values as unknown and validates the required numeric members before comparing nodes. No unchecked cast or explicit any declaration is needed in the checker.

## Coverage and remaining work

The policy includes `test/types/attributes.d.ts`, which the current Oxlint parser cannot read. That fixture retains its narrow Oxlint exclusion, while the compiler-backed policy checks it without a syntax exception.

A clean syntax scan does not prove every inferred or third-party type is safe. Strict compiler checks and unsafe-flow lint rules cover the active checked programs. Issue #50 owns narrower public event and stream boundaries. Issue #57 records the inventory, policy tests and review evidence.

The CLI regressions cover valid and invalid annotations, error severity, failing exit codes, review-discovered inline and braceless cases, and a hidden verification fixture discovered by the default repository scan. The pinned compiler API is a beta dependency, so those executable checks must pass when it is updated.
