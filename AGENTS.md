# TypeScript and lint policy

- Never introduce TypeScript's `any` type in repository-owned code. Use specific types or narrow `unknown` at the seam where data enters.
- Keep Oxlint rules active. Add a suppression only when it is necessary to preserve a verified contract and a type or code change cannot express that contract. Scope the exception to the smallest location and rule. Explain the concrete behavior or type that would break and point to its evidence.
- A comment that repeats what the code does does not justify a suppression. Avoid moving the exception into a helper, a compiler directive or a broader lint setting.
- Preserve promise identity, writable consumer fields and native buffer ownership when changing declarations or removing suppressions. Run strict type checks, lint and the relevant behavior tests before proposing a merge.
