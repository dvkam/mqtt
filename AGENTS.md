# TypeScript and lint policy

- Never introduce TypeScript's `any` type in repository-owned code. Use specific types or narrow `unknown` at the seam where data enters.
- Keep Oxlint rules active. Ideally the code is clean and has no lint or compiler exceptions. Add an ignore only when removing it would sacrifice performance and speed, or cause a really big developer-experience regression. Scope it to the smallest location and rule. Give it an explaining comment that states what breaks, as a measured number or as the code a consumer or contributor would have to write instead, and points to the evidence.
- A comment that repeats what the code does does not justify a suppression. Avoid moving the exception into a helper, a compiler directive or a broader lint setting.
- Preserve promise identity, writable consumer fields and native buffer ownership when changing declarations or removing suppressions. Run strict type checks, lint and the relevant behavior tests before proposing a merge.

# Commits, branches and pull requests

- Commits use the identity in `git config user.name` and `git config user.email` of the owner's checkout. An agent sets no other identity. In a fresh clone that has no identity, or in a hosted clone that came with an identity other than the owner's, ask the owner before the first commit. Use the identity of the owner's recent commits on `main` only when the owner has said so in the session.
- A commit message and a pull request body describe only the change. The author adds no AI or tool attribution, no `Co-Authored-By` line and no session link to either. A pull request body may still end with a footer, because the service that opens the pull request appends it after the author sends the body. The author cannot remove it, so the report to the owner says that the body carries it.
- Name a branch for its change, with a prefix that names the kind of work, such as `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `perf/`, `chore/`, `ci/`, `deps/`, `types/`, `research/` or `spike/`. A branch name contains no tool or agent name.
- A pull request body has three sections: Summary, Evidence and Merge danger. Merge danger has a `Door` line and a `Blast radius` line. `Door` says one-way or two-way, which means whether the change can be reversed after release. `Blast radius` says who and what a mistake would affect.
- Compare every pull request's diff with the model coverage in `.agents/skills/verify-mqtt-lifecycle/SKILL.md`, run `node verification/check.ts`, and state the result in the body.

# Prose

Comments, docs, commit messages and pull request bodies use whole sentences, one name for each thing, a period or a comma where an em dash would go, and a colon only before a list or an example. A comment gives a reason or a constraint that the code cannot show.

# Performance and targets

- Performance is a requirement. The message path is the code that runs once for each publish or for each received message. It is the functions below and the functions they call for each message.
  - Publish: `PortableClient.publish`, `publishPacket`, `transmitter` and `sendIdentified` in `src/portable.ts`, `capturePublication` in `src/publication.ts`, `PublicationAdmission.reserve` in `src/publicationAdmission.ts`, `QosZeroWrites.run` in `src/qosZeroWrites.ts`, `OutboundQosOne.enqueue`, `drain`, `start`, `complete` and `accept` in `src/outboundQosOne.ts`, `packetSender` in `src/diagnostics.ts`, `send` in `src/transportCore.ts`, `allowsNativeWrite` in `src/nativeWriteBudget.ts`, `encodePacket` in `src/wireCodec.ts`, and `write` in `src/tcpClient.ts`, `src/websocketClient.ts` and `src/browserClient.ts`.
  - Receive: `PacketInput.push` in `src/packetInput.ts`, `PacketFramer.push` in `src/packetFramer.ts`, `decodeFramedPacket` in `src/wireCodec.ts`, `readProperties` in `src/wireProperties.ts`, `inboundPacketListener` in `src/inboundPackets.ts`, `publishMessage` in `src/messageProperties.ts`, `packetReceiver` in `src/diagnostics.ts`, and the packet listener in the `PortableClient` constructor, `receiveQosOne` and `deliverQosOne` in `src/portable.ts`.
- A pull request that changes the message path reports these numbers for the base and for the branch: operations per second, p50 and p99 latency and sampled bytes per publish from `test/bench/packed-qos0.ts`, the echo result from `test/bench/packed-echo.sh`, and the count of deoptimizations in the message path from a `--trace-deopt` run. `docs/measurements.md` has the commands.
- A pull request that changes nothing in the message path, or that leaves the built JavaScript of the message path functions byte identical, says so in its body and measures nothing.
- The build targets ES2025, and Node 26 is the only supported Node line. `docs/design-decisions.md` records the decision.
