# Type policy

`pnpm lint` runs the strict Oxlint checks and a repository-wide no-any check. `pnpm lint:policy` runs the latter alone. The policy uses the AST API supplied by the pinned TypeScript 7.1 beta. It adds no dependency and uses the same syntax parser as the compiler.

Oxlint runs type-aware linting through the Rust `tsrs` backend. `tsrs` is a prerelease, pinned to an exact version like the TypeScript beta, so rerun `pnpm lint` and `pnpm test:types` when either is updated. If `tsrs` is missing, `pnpm lint` fails instead of skipping the type-aware rules. Every type-aware rule registered in the pinned Oxlint, 62 in Oxlint 1.95.0, is an error, including unsafe class instance assignment and unhandled promises. List the installed rules with `pnpm exec oxlint --rules --format json` and inspect the effective config with `pnpm exec oxlint -c oxlint.config.mjs --print-config`. [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html)

CI runs `test`, `test:types`, `lint`, `format:check` and `build` on Ubuntu and Windows for every pull request and push to `main`. Each platform job, `checks (ubuntu-26.04)` or `checks (windows-latest)`, installs once and runs every check as a step of its own. A check still runs when an earlier check failed, and it starts without the `dist` and `.type-fixtures` output of an earlier check. Each check also reports as a status of its own on every run, such as `lint (windows-latest)`. That status passes only when the step of the check passed. A run that a newer push cancelled shows cancelled entries instead of the ten statuses. `test:types` runs the compiler on the sources, the compiler-only ambient import attribute fixture and the declaration consumers. Lint reads emitted declarations, so its step first runs `pnpm lint:declarations`, which emits them with `--noCheck`. A type error then fails `test:types`, and `build` when the error is in `src`. Lint still reports its own findings. Run `pnpm test:types` or `pnpm lint:declarations` before `pnpm lint` locally. The required `checks (ubuntu-26.04)` and `checks (windows-latest)` statuses each pass only when all five checks pass on that platform. [CI workflow](../.github/workflows/ci.yml)

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

Negative fixtures live in operating-system temporary directories. The default-discovery regression uses a fresh Git repository with a hidden verification fixture. It checks discovery logic; it does not cover every ignore setting in this checkout. Ordinary repository lint can run while these fixtures exist without scanning their deliberately invalid code.
