# Proposal: an API reference built on the TypeScript 7.1 API

Status: draft for discussion. Nothing in this proposal is built yet.

## Issues

[#22](https://github.com/dvkam/mqtt/issues/22) owns this work, and this proposal keeps all four of its acceptance boxes. The first box, the content of the guides, is separate work. The table shows where the other three land.

| Box of #22 | Where this proposal meets it |
| --- | --- |
| 2. Type-check runnable snippets against the packed package, link each public export to its reference, flag documented APIs that the package does not export | Design items 2, 5 and 6 |
| 3. The static site and the plain-text index are built from the same versioned source | Design items 2, 3 and 4 |
| 4. Consider a content mapper only if a format needs a typed module view and the loader can match it | The rule below |

**The rule for content mappers.** Box 4 guards against one failure. A mapper gives TypeScript a typed view of a file that code imports, and the Vite or runtime loader then produces something else, so the types lie. That failure needs an import. No code imports a guide. The Markdown mapper in this proposal is therefore check-only: `tsc` reads the guides through it with `noEmit`, nothing is emitted, and no module resolves to a `.md` file. The condition of box 4 stays in force for every format that code imports, which is the `.mqtttrace` experiment of [#26](https://github.com/dvkam/mqtt/issues/26). #26 can reuse the mapper mechanics and the external-code opt-in described here.

The owner's instruction in the working session on 26 November 2026 was to use a Markdown content mapper now, with the 7.1 beta, without waiting for the final release. A wording for box 4 that holds both the instruction and the guard is "Use a content mapper freely for inputs that are only checked, such as the guides. For a format that code imports, use one only if the Vite or runtime loader produces the same module."

The owner's comment on #22 of 23 November 2026 links this work to [#179](https://github.com/dvkam/mqtt/issues/179) and [#21](https://github.com/dvkam/mqtt/issues/21). The #179 walkthrough compares the documented exports and examples with the packed declarations, which is the check in design item 5. When the playground components of #21 land, the same generator reads their declarations and the same mapper checks their usage examples.

## Problem

The repository has hand-written guides but no API reference. TypeDoc and API Extractor depend on the TypeScript 6 compiler API, which TypeScript 7 does not have. Waiting for them would block the reference for an unknown time. Pinning TypeScript 6 next to 7 would add a second compiler to keep in sync.

## Proposal

Build a small generator in the repository on the API that TypeScript 7.1 ships. It reads the declarations of the public entry points with their doc comments and writes the reference from them. Content mappers are also new in 7.1. TypeScript ships no mapper for Markdown, so this repository adds one, and `tsc` then type-checks the code in the guides. Both work with the pinned 7.1 beta.

The API is split into entry points. `typescript/sync` is a synchronous client with the program and checker APIs. `typescript/fs` builds full and layered in-memory file systems. `typescript/ast` has the node types and enums. API, snapshot and program objects hold memory on the Go side of the compiler, so the generator disposes them with `using`.

The [TypeScript 7.1 beta announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) expects a release candidate "in about a month" and a final release shortly after it. npm published the beta on 20 October 2026. On 28 November 2026 npm lists no 7.1 release candidate.

## What a prototype showed

Prototype scripts ran on 28 November 2026 against `main` at 8398718 with the pinned `typescript@7.1.0-beta`. They ran in a scratch project that had the tarball packed from that commit installed, so `mqtt` resolved to the packed declarations. The scripts are not part of this proposal's diff.

**Reading the API.**

- The script reads the entry points from `exports` in the tarball's `package.json` and opens the declaration file of each one in a program made with `api.createSnapshot({ createPrograms: [...] })`. A project of the repository opens the same way with `openProjects: ['tsconfig.json']`, and `project.checker` and `project.program` then give the checker and the program.
- `checker.getExportsOfModule(checker.getSymbolOfNode(sourceFile))` lists the exports of an entry, and `checker.getAliasedSymbol` resolves re-exports.
- `symbol.getDocumentationComment(checker)` and `symbol.getJsDocTags(checker)` return the doc comment and its tags.
- `checker.getDeclaredTypeOfSymbol`, `checker.getTypeOfSymbol`, `symbol.getMembers()` and `checker.typeToString` give interface members and printed types. `PublishProperties`, for example, came back with each property, its type and its doc comment.
- Several entry points export the same declaration. The six entry points list 140 exports, which are 65 declarations.

| Measurement | Result |
| --- | --- |
| Entry points in `exports` | 6: `mqtt`, `mqtt/browser`, `mqtt/portable`, `mqtt/codec`, `mqtt/ws`, `mqtt/websocket` |
| Exports listed across the entry points | 140 |
| Exported declarations | 65 |
| Declarations with a doc comment | 33 |
| Declarations without one | 32 |
| Interface members | 138, of which 56 have no doc comment |
| Time to read all of it | 198 to 243 ms in three runs |

The first version of this proposal reported 103 exports, 33 with a doc comment, at 4904bec. It counted an export once for each of five entry points and left out `mqtt/websocket`. Counted as declarations over all six entry points, that commit had 51, of which 17 had a doc comment.

**Checking the examples in the guides.**

- A content mapper of 51 lines turned each fenced `ts` block of a Markdown file into one TypeScript input. A `tsconfig.json` in the scratch project included `README.md`, `docs/*.md` and `docs/recipes/*.md` and listed the mapper under `contentMappers`.
- `tsc -p . --runExternalCode` checked the 20 blocks in 0.52 to 0.59 s in five runs. 17 blocks are in `docs/*.md`, 2 in `docs/recipes/` and 1 in `README.md`.
- It reported 21 errors, each at its Markdown line and column, for example `docs/publishing.md(35,13): error TS7006: Parameter 'message' implicitly has an 'any' type.`
- 20 of the 21 come from blocks in `docs/*.md` that are fragments. They use names such as `session` or `client` without declaring them, leave out imports, or leave a callback parameter without a type. The other error is in `docs/recipes/using-logs-to-debug.md`, which imports `pino`, a package the scratch project did not have. The block in `README.md` has no error.
- A second script got the same 20 errors for `docs/*.md` without a mapper. It ran inside the repository after a build, added each block as an in-memory file with `createFileSystemLayer` and checked one program in 725 to 839 ms.
- Without `--runExternalCode`, `tsc` stops with `error TS18068: Content mappers require the '--runExternalCode' command line flag to be enabled.`

**A stale build.** Run inside the repository, an import of `mqtt` in a guide resolves through the package's own name to `dist/`. During the review of this proposal, `dist/` came from an earlier commit and lacked `resetSession`. The check ran against it and gave no sign that the declarations were old. The check must therefore run against the tarball that the same CI run packed.

## Design

1. **Source of truth.** The reference comes from the TSDoc comments on the public declarations in `src`: a summary sentence, `@param`, `@returns`, `@throws {MqttError}` with the code, `@defaultValue` and `@example`. The guides keep the explanations, and the reference keeps the contract.
2. **Model.** The generator reads the entry points from `exports` in `package.json` and the declaration files of the packed tarball. It writes `docs/api/model.json`, with one entry per declaration: the entry points that export it, name, kind, printed type, members, doc comment, tags and source location. A pull request that changes the public API also changes the model, so the change is visible in review.
3. **Pages.** The owner wants fewer Markdown files, and a separate proposal is shrinking `docs/`, which holds 86 of them. The reference therefore adds no checked-in page per entry point. The VitePress site that #22 asks for renders the pages from the model when it builds. If the reference must also read on GitHub, the generator writes one file, `docs/api.md`.
4. **Agent index.** The generator writes the small plain-text index that #22 asks for from the same model: one line per declaration with its entry points, kind, summary sentence and link. The site and the index come from one model in one run, and the drift check in item 6 covers both.
5. **Examples.** One extractor module finds the fenced blocks and their positions. It has two front ends. The content mapper serves `tsc` and the editor, so an error shows at its line in the Markdown file. The in-memory front end adds each block with `createFileSystemLayer` and needs no external code. The prototype got the same errors from both. CI gates on the mapper. If a later beta changes the mapper protocol, the gate switches to the in-memory front end in one line and loses no coverage.
   - The check runs in the project of the packed-consumer CI job, which already installs the tarball into a clean directory. CI copies `README.md`, `docs/*.md` and `docs/recipes/*.md` there, installs the mapper package from this repository and runs `tsc -p . --runExternalCode`. Imports of `mqtt` then resolve to the packed package, as #22 asks, and an import of a name that the package does not export is an error.
   - `contentMappers` appears only in the tsconfig of that check. The tsconfig that builds the package lists no mapper and runs without `--runExternalCode`, so building and packing execute no external code.
   - A shared preamble declares the names the fragments use, such as `session: ClientSession` and `client: ClientFactory`, so a fragment stays short and still type-checks.
   - A block that should not compile carries a marker, and the mapper turns it into an expected diagnostic. This is the failing usage fixture that the owner's comment on #22 asks for.
   - The project installs the packages that a recipe imports, such as `pino`, or the preamble declares them.
   - The two `js` blocks, in `README.md` and `docs/measurements.md`, can go through the mapper with the `.js` extension. The prototype did not test that.
   - A mapper cannot take `@example` blocks from doc comments, because `.ts` is a reserved extension that no mapper may claim. The generator extracts those blocks and checks them through the in-memory front end. `src` has no `@example` block today.
   - The announcement says that in VS Code content mappers need workspace trust and the content mapper permission, and that the setting `js/ts.contentMappers.enabled` turns them off. The prototype did not test the editor.
6. **Checks in CI.** CI runs three checks:
   - Every exported declaration and member has a doc comment. This check starts as a report, then fails CI once the existing gaps are filled.
   - The checked-in model, and `docs/api.md` if it exists, match the declarations. `docs:api --check` fails when they differ.
   - The example check of item 5 passes, with errors reported at their Markdown lines.
7. **Size.** The tooling is a few hundred lines under `lint/` or a new `docs/tooling/`, with no new dependency. It uses the TypeScript package the repository already pins, and it follows the repository's lint and type policy.

## Content mappers

The protocol is in the TypeScript source, in `tsc/internal/contentmapper/protocol_generated.go` and `packages/typescript/schemas/contentmapper.schema.json`, read at commit 6327ae166 of `microsoft/TypeScript`:

- **Declaring a mapper.** A project lists it in `tsconfig.json` under `contentMappers`, with a package name, extensions and options. The compiler resolves the package from the project, and its `package.json` declares `"typescript": { "contentMapper": { "exec": ["node", "./mapper.mjs"], "extensions": [".md"] } }`. `tsc` runs it only with `--runExternalCode`. A mapper cannot claim an extension that TypeScript handles itself, such as `.ts`, `.js` or `.json`.
- **Talking to it.** The compiler spawns `exec` with the package directory as its working directory and talks JSON-RPC over its stdin and stdout, with LSP-style `Content-Length` framing. One process serves every project that uses the same mapper name and version.
- **Requests.** `initialize` picks UTF-8 or UTF-16 positions and a diagnostic prefix. `openProject` receives the mapper options and the effective compiler options. `transform` receives a file name and its text and returns the virtual text, its extension and span map segments `[virtualStart, virtualLength, originalStart, originalLength, kind]`, with an optional sixth element for features. The kind is verbatim, atom or alias. `closeProject` releases a project.
- **Results.** A transform result can also carry mapper diagnostics in original coordinates, diagnostic directives that ignore or expect an error in a range, and supplemental inputs. The prototype used one supplemental input per code block, so blocks that declare the same names do not collide.

The announcement lists mappers that were prototyped or implemented for Astro, CSS Modules, Ember, MDX, Svelte and Vue, and an example mapper for HTML files. It names none for plain Markdown.

## Risks

- The API is a beta until 7.1 is final. A rename would break the generator but not the library. Pinning the exact version and keeping the generator small limits the cost.
- `typeToString` prints types as the checker sees them, for example `Uint8Array<ArrayBufferLike>`. The pages may need a few printing rules.
- A content mapper runs external code, so CI must opt in with `--runExternalCode`, and editors need workspace trust. The mapper is code in this repository, so the opt-in covers only our own script. #26 asks to document that opt-in and to keep it out of the package build, and the example check does both, because it runs after the build in its own project.
- The mapper protocol may change before 7.1 is final. The mapper is small, and the example check fails when the compiler no longer accepts its answers. The in-memory front end of design item 5 keeps the gate running while the mapper is updated.

## Steps

1. Add the generator and `docs/api/model.json`, and report doc comment coverage in CI without failing.
2. Add the Markdown content mapper, the preamble and the example check in the packed-consumer job, and fix the 21 errors in the current guides.
3. Write doc comments for the 32 declarations and the 56 interface members that lack one, one entry point at a time, then make the coverage check fail CI.
4. Write the agent index and the drift check, and render the pages in the VitePress site of #22.
