# Contributing

Use this fork's [issues](https://github.com/dvkam/mqtt/issues) to report bugs and discuss changes. State the runtime, transport, broker, package commit and reproduction steps. Remove credentials and private payloads from reports and traces.

The preview profile is described in the [README](../README.md), [browser guide](../docs/browser-client.md) and [codec guide](../docs/codec.md). Link the owning issue before broadening a public contract. The retained legacy API does not define the target architecture.

## Setup and checks

Use the Node version in [.node-version](../.node-version) and the pnpm version in [package.json](../package.json). Keep direct dependency versions fixed and preserve the lockfile. Use the workspace release-age policy rather than adding exceptions for a routine update.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:types
pnpm lint
pnpm format:check
pnpm build
```

Add a regression that fails for the reported behavior before fixing a bug. Check the failure reason and process exit code. Tests should inspect observable protocol, lifecycle or public API behavior rather than copy an implementation. For type changes, include valid and invalid consumers and verify contextual inference.

Use descriptive names and specific types. Do not add explicit `any`, unchecked casts or broad lint exclusions to make a check pass. Accept `unknown` at an untrusted boundary and narrow it. Prefer removing a suppression through a behavior-preserving change. If an API contract requires a narrow suppression, explain the behavior it preserves. Issue [#57](https://github.com/dvkam/mqtt/issues/57) tracks the remaining no-any enforcement gaps.

## Integration and review

Use scripted peers for exact packet assertions and deliberate faults. Use the packed Mosquitto checks for an independent broker exchange. The packed-consumer CI job installs the tarball in a clean project and checks public declarations, browser imports and supported broker sessions. A source build alone does not prove the installed package works.

For lifecycle changes, follow the [verification guide](../.agents/skills/verify-mqtt-lifecycle/SKILL.md). Compare the implementation with each model's scope, run positive and deliberately broken cases, and report limitations. A model check does not establish conformance for unmodeled protocol behavior.

Keep commits focused. Describe the problem, resulting behavior, tests and remaining limits in the PR. Run separate standards and specification reviews, challenge the conclusions, address findings and rerun affected checks. Report unavailable checks and review limitations. Merge only after required CI checks pass.

Changes to package exports or dependencies also need a packed consumer check. Browser changes need evidence that Node-only dependencies stay out of the browser graph. Record repeatable performance measurements before claiming an improvement.

## Releases and governance

The publishing name, ownership and opt-in canary process remain in [#24](https://github.com/dvkam/mqtt/issues/24). A tarball artifact is a testable preview, not an npm release. Do not publish under the inherited package identity without resolving that work.

Issue [#48](https://github.com/dvkam/mqtt/issues/48) tracks license verification, inherited media, and a maintainer-approved conduct reporting contact. The existing conduct file still needs that review; do not assume its inherited contact represents this fork. Human and agent API references are planned in [#22](https://github.com/dvkam/mqtt/issues/22).
