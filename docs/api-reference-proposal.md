# Proposal: an API reference built on the TypeScript 7.1 API

Status: draft for discussion. Nothing in this proposal is built yet.

## Problem

The repository has hand-written guides but no API reference. TypeDoc and API Extractor depend on the TypeScript 6 compiler API, which TypeScript 7 does not have. Waiting for them would block the reference for an unknown time. Pinning TypeScript 6 next to 7 would add a second compiler to keep in sync.

## Proposal

Build a small generator in the repository on the API that TypeScript 7.1 ships. It reads the public entry points, their declared types and their doc comments, and writes the reference as Markdown next to the guides. A content mapper for Markdown, also new in 7.1, lets `tsc` type-check the code in the guides. Both work with the pinned 7.1 beta, so the work does not wait for the final release.

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

- A content mapper of about 60 lines turned each fenced `ts` block of a Markdown file into one TypeScript input. A `tsconfig.json` included `docs/*.md` and listed the mapper under `contentMappers`.
- `tsc -p <that config> --runExternalCode` checked the 14 blocks in `docs/` in 0.54 s, from the command line, with the pinned beta.
- It reported 16 errors, each at its Markdown line and column, for example `docs/publishing.md(35,13): error TS7006: Parameter 'message' implicitly has an 'any' type.`
- All 16 come from blocks that are fragments. They use names such as `session` or `client` without declaring them, leave out imports, or leave a callback parameter without a type.
- A second script got the same 16 errors without a mapper, by adding each block as an in-memory file with `createFileSystemLayer` and checking one program in 674 ms.

## Design

1. **Source of truth.** TSDoc comments on the public declarations in `src`: a summary sentence, `@param`, `@returns`, `@throws {MqttError}` with the code, `@defaultValue` and `@example`. The guides keep the explanations, and the reference keeps the contract.
2. **Model.** The generator writes `docs/api/model.json`, with one entry per export: entry point, name, kind, printed type, members, doc comment, tags and source location. A pull request that changes the public API also changes the model, so the change is visible in review.
3. **Pages.** One Markdown page per entry point under `docs/api/`, rendered from the model, with links between types. Markdown reads well on GitHub. A site generator can use the same files later.
4. **Examples.** A Markdown content mapper in the repository turns each fenced `ts` block into a TypeScript input, and `docs/tsconfig.json` includes the guides and lists the mapper. `tsc -p docs --runExternalCode` then checks the guides. The 7.1 release notes say that VS Code also runs mappers once workspace trust and the mapper permission are granted, so the errors would show inside the Markdown. The prototype did not test the editor. A shared preamble in `docs/api/examples.d.ts` declares the names the fragments use, such as `session: ClientSession` and `client: ClientFactory`, so a fragment stays short and still type-checks. A block that should not compile carries a marker that the mapper turns into an expected diagnostic. The generator checks `@example` blocks in doc comments through the same mapper.
5. **Checks in CI.** Three checks:
   - Every public export and member has a doc comment. This check starts as a report, then fails CI once the existing gaps are filled.
   - The checked-in pages match the model. `docs:api --check` fails when they differ.
   - `tsc -p docs --runExternalCode` passes, so every example type-checks, with errors reported at their Markdown lines.
6. **Size.** A few hundred lines under `lint/` or a new `docs/tooling/`, with no new dependency. It uses the TypeScript package the repository already pins, and it follows the repository's lint and type policy.

## Content mappers

The protocol is in the TypeScript source, in `tsc/internal/contentmapper/protocol_generated.go` and `packages/typescript/schemas/contentmapper.schema.json`:

- **Declaring a mapper.** A project lists it in `tsconfig.json` under `contentMappers`, with a package name, extensions and options. The compiler resolves the package from the project, and its `package.json` declares `"typescript": { "contentMapper": { "exec": ["node", "./mapper.mjs"], "extensions": [".md"] } }`. `tsc` runs it only with `--runExternalCode`.
- **Talking to it.** The compiler spawns `exec` with the package directory as its working directory and talks JSON-RPC over its stdin and stdout, with LSP-style `Content-Length` framing. One process serves every project that uses the same mapper name and version.
- **Requests.** `initialize` picks UTF-8 or UTF-16 positions and a diagnostic prefix. `openProject` receives the mapper options and the effective compiler options. `transform` receives a file name and its text and returns the virtual text, its extension and span map segments `[virtualStart, virtualLength, originalStart, originalLength, kind]`. The kind is verbatim, atom or alias. `closeProject` releases a project.
- **Results.** A transform result can also carry mapper diagnostics in original coordinates, diagnostic directives that ignore or expect an error in a range, and supplemental inputs. The prototype used one supplemental input per code block, so blocks that declare the same names do not collide.

Mappers exist or have been prototyped for Astro, CSS Modules, Ember, MDX, Svelte, Vue and HTML.

## Risks

- The API is a beta until 7.1 is final. A rename would break the generator but not the library. Pinning the exact version and keeping the generator small limits the cost.
- `typeToString` prints types as the checker sees them, for example `Uint8Array<ArrayBufferLike>`. The pages may need a few printing rules.
- A content mapper runs external code, so CI must opt in with `--runExternalCode`, and editors need workspace trust. The mapper is code in this repository, so the opt-in covers only our own script.
- The mapper protocol may change before 7.1 is final. The mapper is small, and its CI check fails at once if the protocol changes.

## Steps

1. Add the generator and `docs/api/model.json`, and report doc comment coverage in CI without failing.
2. Add the Markdown content mapper, `docs/tsconfig.json`, `docs/api/examples.d.ts` and the CI step `tsc -p docs --runExternalCode`, and fix the 16 errors in the current guides.
3. Write doc comments for the 70 exports that lack one, one entry point at a time, then make the coverage check fail CI.
4. Render the Markdown pages and add the drift check.
