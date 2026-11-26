# Proposal: an API reference built on the TypeScript 7.1 API

Status: draft for discussion. Nothing in this proposal is built yet.

## Problem

The repository has hand-written guides but no API reference. TypeDoc and API Extractor depend on the TypeScript 6 compiler API, which TypeScript 7 does not have. Waiting for them would block the reference for an unknown time. Pinning TypeScript 6 next to 7 would add a second compiler to keep in sync.

## Proposal

Build a small generator in the repository on the API that TypeScript 7.1 ships. It reads the public entry points, their declared types and their doc comments, and writes the reference as Markdown next to the guides. The same API type-checks the code in the guides.

The API is split into entry points. `typescript/sync` is a synchronous client with the program and checker APIs. `typescript/fs` builds full and layered in-memory file systems. `typescript/ast` has the node types and enums. API, snapshot and program objects hold memory on the Go side of the compiler, so the generator disposes them with `using`. The TypeScript team plans a 7.1 release candidate about a month after the October 2026 beta, then a final release.

## What a prototype showed

Two prototype scripts ran against `main` with the pinned `typescript@7.1.0-beta`. They are not part of this proposal's diff.

**Reading the API.**

- The script opens the project with `api.createSnapshot({ openProjects: ['tsconfig.json'] })`, then takes `project.checker` and `project.program`.
- `checker.getExportsOfModule(checker.getSymbolOfNode(sourceFile))` lists the exports of an entry, and `checker.getAliasedSymbol` resolves re-exports.
- `symbol.getDocumentationComment(checker)` and `symbol.getJsDocTags(checker)` return the doc comment and its tags.
- `checker.getDeclaredTypeOfSymbol`, `checker.getTypeOfSymbol`, `symbol.getMembers()` and `checker.typeToString` give interface members and printed types. `PublishProperties`, for example, came back with each property, its type and its doc comment.
- For the entries `mqtt`, `mqtt/browser`, `mqtt/portable`, `mqtt/codec` and `mqtt/ws`, the script read 103 exports with their members in 197 ms. 33 of the 103 had a doc comment.

**Checking the examples in the guides.**

- The script collected the 14 fenced `ts` blocks in `docs/`.
- It added each block as an in-memory file with `createFileSystemLayer`, over the host file system, and created one program for all of them. No file was written.
- `getSyntacticDiagnostics` and `getSemanticDiagnostics` ran in 674 ms. Each diagnostic carries its file and line, so the script printed the Markdown line, for example `docs/publishing.md:31 TS2304 Cannot find name 'createTcpClient'`.
- All 16 diagnostics come from blocks that are fragments. They use names such as `session` or `client` without declaring them, leave out imports, or leave a callback parameter without a type.

## Design

1. **Source of truth.** TSDoc comments on the public declarations in `src`: a summary sentence, `@param`, `@returns`, `@throws {MqttError}` with the code, `@defaultValue` and `@example`. The guides keep the explanations, and the reference keeps the contract.
2. **Model.** The generator writes `docs/api/model.json`, with one entry per export: entry point, name, kind, printed type, members, doc comment, tags and source location. A pull request that changes the public API also changes the model, so the change is visible in review.
3. **Pages.** One Markdown page per entry point under `docs/api/`, rendered from the model, with links between types. Markdown reads well on GitHub. A site generator can use the same files later.
4. **Examples.** The generator checks every fenced `ts` block in `docs/` and every `@example` as in-memory files, as the prototype did. A shared preamble in `docs/api/examples.d.ts` declares the names the fragments use, such as `session: ClientSession` and `client: ClientFactory`, so a fragment stays short and still type-checks. A block that should not compile is marked as such.
5. **Checks in CI.** Three checks:
   - Every public export and member has a doc comment. This check starts as a report, then fails CI once the existing gaps are filled.
   - The checked-in pages match the model. `docs:api --check` fails when they differ.
   - Every example type-checks, with errors reported at their Markdown lines.
6. **Size.** A few hundred lines under `lint/` or a new `docs/tooling/`, with no new dependency. It uses the TypeScript package the repository already pins, and it follows the repository's lint and type policy.

## Content mappers

TypeScript 7.1 adds content mappers. A mapper is a package listed under `contentMappers` in `tsconfig.json` with the file extensions it handles, for example:

```json
{ "contentMappers": [{ "package": "@scope/markdown-mapper", "extensions": [".md"] }] }
```

TypeScript asks the mapper for a virtual TypeScript version of each matching file, and maps errors and spans back to the original file. `tsc` uses mappers only with `--runExternalCode`, because a mapper is an external program. Editors also require workspace trust and a permission. Mappers exist or have been prototyped for Astro, CSS Modules, Ember, MDX, Svelte, Vue and HTML.

With a Markdown mapper, `tsc` and the editor would check the guides directly, with no separate script. The in-memory check above does the same job in CI today without running external code. A mapper is worth adding after 7.1 is final. The MDX and HTML mappers are the models for it. The process protocol is described in the write-up on the implementing pull request in `microsoft/typescript-go`, which this proposal has not reviewed yet.

## Risks

- The API is a beta until 7.1 is final. A rename would break the generator but not the library. Pinning the exact version and keeping the generator small limits the cost.
- `typeToString` prints types as the checker sees them, for example `Uint8Array<ArrayBufferLike>`. The pages may need a few printing rules.
- A content mapper runs external code, so CI must opt in with `--runExternalCode`.

## Steps

1. Add the generator and `docs/api/model.json`, and report doc comment coverage in CI without failing.
2. Add `docs/api/examples.d.ts` and the example check, and fix the 16 diagnostics in the current guides.
3. Write doc comments for the 70 exports that lack one, one entry point at a time, then make the coverage check fail CI.
4. Render the Markdown pages and add the drift check.
5. Try a Markdown content mapper after 7.1 is final.
