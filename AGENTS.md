# TypeScript and lint policy

- Never introduce TypeScript's `any` type in repository-owned code. Use specific types or narrow `unknown` at the seam where data enters.
- Keep Oxlint rules active. Ideally the code is clean and has no lint or compiler exceptions. Add an ignore only when removing it would sacrifice performance and speed, or cause a really big developer-experience regression. Scope it to the smallest location and rule. Give it an explaining comment that states what breaks, as a measured number or as the code a consumer or contributor would have to write instead, and points to the evidence.
- A comment that repeats what the code does does not justify a suppression. Avoid moving the exception into a helper, a compiler directive or a broader lint setting.
- Preserve promise identity, writable consumer fields and native buffer ownership when changing declarations or removing suppressions. Run strict type checks, lint and the relevant behavior tests before proposing a merge.
