---
name: verify-mqtt-lifecycle
description: Check a change against the TLA+ models in verification/. Use when a diff touches src/, test/experiments/ or verification/.
---

# Verify MQTT lifecycle changes

The models in `verification/` check ownership and ordering rules of the session, the transports and the codec in small finite instances. The `models` job in CI runs every model. You decide what CI cannot: whether the diff changes a rule that a model describes, and whether the model still matches the source.

## Steps

1. Commit your changes, because the commands read commits. List the models that cover the changed source files, then the models that the diff itself changes.

       git diff --name-only origin/main...HEAD -- src test/experiments | xargs -I{} grep -lF "Source: {} (" verification/*.tla | sort -u
       git diff --name-only origin/main...HEAD -- verification

   When both lists are empty, no model covers the diff. State that and stop.

2. Read the header comment of each listed model. Its `Source:` lines name the functions it covers, and its `Mapping:` paragraph ties each action to one of them. Compare the header with the diff. This step is done when each changed function that a header names, and each new function in a file that a header names, has one verdict: rule unchanged, model updated, or bug.

3. For a changed rule, change the source first and the model second, and update the header in the same commit. Keep every invariant, bound and timeout at least as strong as before, and never relax one to obtain a pass. When the model is right and the source is wrong, report a bug with the TLC trace.

4. For a new or changed guard, add an expected fault: a configuration that removes the guard. List it in `models` in `verification/check.ts` with the invariant it must violate.

5. Run the models, then the header check and the tests that the header names. `verification/README.md` says which Node, Java and TLC jar the runner needs.

       TLC_JAR=/path/to/tla2tools.jar node verification/check.ts
       pnpm test test/verification-headers.test.ts <test files from the header>

   Each positive model prints its state count. Each expected fault prints `caught` and its invariant. Report a parse error or a Java start failure as a blocked run. Run the two commands one after the other, because the runner uses every core and a test watchdog can expire beside it.

6. For a new guard, remove it in a scratch worktree and confirm that a test from the header fails. Discard the worktree.

## State in the pull request body

- Each listed model and its verdict, or that the diff touches no model.
- For a changed model, its state count and each expected fault with the invariant it caught.
- For a new guard, the test that failed without it.
- What the model leaves out for this change, from its `Not modeled:` paragraph.

`verification/README.md` explains how to write a model and its header, and lists the rules that no model covers.
