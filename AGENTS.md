# TypeScript and lint policy

- Never introduce TypeScript's `any` type in repository-owned code. Use specific types or narrow `unknown` at the seam where data enters.
- Keep Oxlint rules active. Add a suppression only when it is necessary to preserve a verified contract and a type or code change cannot express that contract. Scope the exception to the smallest location and rule. Explain the concrete behavior or type that would break and point to its evidence.
- A comment that repeats what the code does does not justify a suppression. Avoid moving the exception into a helper, a compiler directive or a broader lint setting.
- Preserve promise identity, writable consumer fields and native buffer ownership when changing declarations or removing suppressions. Run strict type checks, lint and the relevant behavior tests before proposing a merge.

# Commits, branches and pull requests

- Commit as the repository owner's configured Git identity. A commit message and a pull request body describe only the change. They carry no AI or tool attribution, no co-author line and no session link.
- Name a branch for its change, with a `feat/`, `fix/`, `chore/`, `ci/` or `docs/` prefix and no tool name.
- A pull request body has three sections: Summary, Evidence and Merge danger.
- Compare every pull request's diff with the model coverage in `.agents/skills/verify-mqtt-lifecycle/SKILL.md`, run `node verification/check.ts`, and state the result in the body.

# Prose

Comments, docs, commit messages and pull request bodies use whole sentences, one name for each thing, a period or a comma where an em dash would go, and a colon only before a list or an example. A comment gives a reason or a constraint that the code cannot show.

# Performance and targets

- Performance is a requirement. When a change touches the publish or receive path, measure the steady state before and after with `test/bench/packed-qos0.ts` and `test/bench/packed-echo.sh`, and put the numbers in the pull request body. When a hot path changes, add the sampled allocation per publish and a `--trace-deopt` run. `docs/measurements.md` has the commands.
- The build targets ES2025, and Node 26 is the only supported Node line. `docs/design-decisions.md` records the decision.
