# Phase 5 — Frontend foundation

**Project 3 · AI Support Desk**
Status: complete. **The first phase with running code**, and the first CI can check.

---

## 1. What exists now

```
client/
  package.json  vite.config.js  index.html
  src/
    main.jsx  App.jsx
    styles/      tokens.css  global.css          ← ported from Project 2
    lib/         outcomes.js  api.js  useEventStream.js
    context/     AuthContext.jsx
    components/
      primitives/  Button  Input  Badge  Modal   ← ported, Modal modified
      PolicyBlock.jsx                            ← new, Phase 4 §5
      ConfirmationDialog.jsx                     ← new, ADR 0009
      ProtectedRoute.jsx
    routes/      LoginPage.jsx  ScaffoldPage.jsx
    test/        4 suites, 39 tests
.github/workflows/ci.yml
```

**Verified:** 39/39 tests pass, production build succeeds (172 kB JS / 56 kB gzipped), dev
server runs on 5179 and renders the sign-in screen with the route guard redirecting `/` →
`/login` as designed.

---

## 2. What was genuinely ported, and what was not

Phase 1 §1.3 promised reuse would be declared rather than blurred. Project 2's repo was open on
disk while this was written, so this is a real port, not a re-derivation described as one.

| From Project 2, unchanged | Modified | New to this project |
|---|---|---|
| `tokens.css` neutrals, accent, spacing, type scale, shadows, dark block | `Modal.jsx` — see §3 | `outcomes.js` |
| `global.css` focus-visible, `.sr-only`, reduced-motion | `tokens.css` — new palettes appended | `PolicyBlock.jsx` |
| `Button.jsx`, `Input.jsx` | | `ConfirmationDialog.jsx` |
| Vite + Vitest + Testing Library setup | | `useEventStream.js` (ported in shape from P1/P2) |

The three token groups appended for this project — `--color-policy-*`, `--outcome-*`,
`--ticket-*` — exist because this project has a semantic distinction the previous two did not:
**a refusal is not an error.** Everything else is Project 2's palette untouched.

---

## 3. The one modification to a ported component

`Modal.jsx` gained an `initialFocus` prop, defaulting to `'heading'`.

Project 2's version focused the **first focusable control** on open. That is the conventional
behaviour, it is right for most dialogs, and it is wrong here: ADR 0009 property 2 requires the
confirm button *not* to hold focus, so that a muscle-memory `Enter` carried over from the
message composer cannot authorise a cancellation the user never read.

`initialFocus="first"` restores the old behaviour for ordinary dialogs. **The default is the
safe one** — the dangerous option is the one you have to ask for.

---

## 4. Three decisions worth reading the code for

### 4.1 `outcomes.js` — one vocabulary, not scattered strings

The four error kinds, the seven terminal outcomes, and the policy ladder live in one module.
This is not magic-string tidying. `isPolicyKind()` exists so a component asks the question
directly rather than re-deriving it — and getting it wrong once is all it takes to render a
refusal as a red error toast.

`mostRestrictive()` encodes ADR 0008's safety property as a testable function: a tenant rule can
only ever move an outcome further right on the ladder.

### 4.2 `api.js` — the error taxonomy is enforced at the boundary

Every failed response becomes an `ApiError` carrying one of the four kinds. **The default is
`fault`, not `refused`** — guessing "refused" would invent a policy decision that never happened
and write a false story into the UI. If we do not know, we say something broke.

### 4.3 `ConfirmationDialog.jsx` fails closed on unknown actions

An action type with no entry in `ACTION_LABELS` **cannot be confirmed**. The dialog renders an
explanation and a Close button instead.

The tempting alternative is a generic "Confirm" fallback. That would mean a new action type —
one nobody has written human-readable labels for, and therefore one nobody has thought about at
the UI layer — becomes confirmable the moment the server can propose it. Failing closed keeps
the UI honest: **if we cannot describe what the button does, we do not offer it.**

---

## 5. Tests

39 tests across four suites, all executable statements of design decisions rather than coverage
for its own sake.

| Suite | Tests | Guards |
|---|---|---|
| `ConfirmationDialog` | 12 | ADR 0009 properties 1–6, plus fail-closed |
| `PolicyBlock` | 11 | Phase 4 §5 — refusals are `note`, faults are `alert`; ADR 0007 two channels |
| `useEventStream` | 11 | SSE frame parsing, including frames split across chunks |
| `outcomes` | 5 | Ladder ordering and ADR 0008's precedence property |

Three worth naming:

- **`Enter` immediately after open does not execute.** This is ADR 0009 property 2 as an
  assertion. Without it, "the confirm button must not be focused" is a sentence in a document
  that a future refactor silently breaks.
- **A refusal renders as `role="note"`, never `role="alert"`.** If someone later reaches for the
  error toast lying around, this fails.
- **A frame split across two chunks is reassembled.** The classic SSE bug: tokens arrive fine
  until a packet boundary lands mid-frame, then one silently vanishes. `parseFrames` is exported
  as a pure function precisely so this can be tested without a network.

---

## 6. CI

`.github/workflows/ci.yml` runs install → test → build on every push and pull request.

`npm ci` rather than `npm install`: it installs exactly the lockfile and fails if
`package.json` and the lock disagree, so CI cannot silently test a different dependency tree
from the one committed.

This is the point of the Phase 1 process change. Projects 1 and 2 were pushed only at the very
end, so CI never ran while the code was being written.

---

## 7. Database: MongoDB Atlas

Decided this phase. **Atlas free tier (M0)**, because Atlas clusters are replica sets by
default — and Phase 3 §9 requires one, since execution commits the order update, the
`ActionOutcome` insert and the `TicketEvent` insert in a single multi-document transaction. A
standalone `mongod` cannot do that, and finding out at Phase 10 would have been a confusing
runtime error.

`.env.example` documents the variable names and the local replica-set fallback for anyone who
would rather not use Atlas. No real value is ever committed.

---

## 8. Known state

- **The API does not exist yet** (Phase 6). `GET /api/auth/me` returns a proxy error, which
  `AuthContext` deliberately treats as "not signed in" rather than surfacing. The dev server
  logs `ECONNREFUSED` on boot; this is expected until Phase 6.
- **`ConfirmationDialog` and `PolicyBlock` are built and tested but not yet mounted in a
  screen.** They are wired up in Phases 9–11 when there is something to confirm.
- Five of the seven Phase 4 screens are `ScaffoldPage` placeholders naming the phase that
  replaces them, so a stub cannot quietly become permanent.

---

*Phase 5 complete. Phase 6 defines the backend API contract — the endpoints from Phase 1 §9,
the four-kind error envelope this client already expects, and the SSE frame shapes
`useEventStream` already parses.*
