# Phase 4 — UI/UX

**Project 3 · AI Support Desk**
Status: complete. Answers Phase 1 open question 1 via
[ADR 0009](../adr/0009-confirmation-is-a-deliberate-modal.md), and turns the
[Phase 2](phase-02-architecture.md) §5 error taxonomy into concrete affordances.

---

## 1. What Phase 4 settled

| Question | Answer | § |
|---|---|---|
| **Phase 1 open question 1** — confirmation modal or inline? | **Focus-trapped modal with seven non-negotiable properties** ([ADR 0009](../adr/0009-confirmation-is-a-deliberate-modal.md)) | 4 |
| How do the four error kinds appear to a user? | Two visual languages — *policy* and *fault*. A refusal never renders as an error | 5 |
| How is streaming announced to assistive tech? | A status region, not a live-region firehose of tokens | 8 |
| How does the console prevent illegal ticket transitions? | Only legal transitions are rendered — and still rejected server-side | 6 |
| How are invalid policy rules prevented? | The editor is generated from the condition registry, so invalid rules are unauthorable | 7 |

One refinement to Phase 3: dismissing a confirmation leaves a proposal **pending**, so a
seventh terminal outcome, `expired`, is needed for proposals nobody ever decides. Added to the
[Phase 3 §4](phase-03-database-design.md#4-the-audit-spine) outcome table.

---

## 2. Design principles for this project

Generic UI craft applies as it would anywhere. These four are specific to what this system
claims about itself.

**1. The UI is the last place the invariant can be undermined.** Nothing downstream of the
confirmation control can protect INV-A — by then the backend has done everything it can. A
design that optimises for speed at that exact moment converts the whole architecture into
theatre. This is the reason ADR 0009 chose friction.

**2. A refusal is the system working, and must never look like a failure.** If a policy refusal
renders as a red error toast, users learn the assistant is broken, agents learn to dismiss
refusals, and the project's central demonstration disappears into an error state. Refusals get
their own visual language (§5).

**3. Show the evidence, not just the answer.** Citations, tool results, and the rule that
blocked an action are first-class content, not debug output behind a toggle. The agent console
in particular is an *explanation* tool before it is a queue.

**4. Say the true thing plainly.** "I don't have information about that" and "cancellation
isn't possible once an order has shipped" are good outcomes stated plainly. No apologetic
hedging, no fake warmth around a hard limit, and never model-generated text for a policy
decision (ADR 0007).

---

## 3. Screen inventory

| Screen | Actor | Purpose |
|---|---|---|
| Conversation | Customer | Multi-turn chat, streamed, with citations |
| Confirmation modal | Customer | Authorise one resolved action (ADR 0009) |
| Queue | Agent, lead | Tickets for the tenant, filterable by state |
| Ticket detail | Agent, lead | Transcript + evidence + proposed reply + blocked actions |
| Policy rules | Lead, admin | Baseline vs tenant rules; the rule editor |
| Audit | Lead, admin | Every proposal and outcome, refusals included by default |
| Auth | All | Login, register, logout (ported from Project 2) |

Seven screens. The customer sees two of them.

---

## 4. Customer conversation

### 4.1 Turn states

```
idle ──▶ sending ──▶ streaming ──▶ complete
                         │
                         └──▶ cancelled        (user stopped it — FR-1.3)
```

While streaming, the composer is replaced by a **Stop** control. A cancelled turn stays in the
transcript, visibly marked as stopped, with whatever text arrived — it is never silently
completed or silently removed (FR-1.3).

### 4.2 Evidence

Citations render as numbered superscript markers resolving to a source panel showing the exact
chunk the model was given (FR-2.3). Tool results — an order lookup — render as a **structured
card** (order number, status, date, items), not as prose inside the assistant's message. A
structured record should look like a record; letting the model narrate it invites it to
narrate it wrongly.

### 4.3 The proposal card

When policy returns `confirm-required`, an inline card appears in the transcript and the modal
opens over it. If the modal is dismissed, the card remains as the re-entry point. The card
shows the action summary and a **Review** button — never the confirm control itself, so the
consequential click exists in exactly one place.

---

## 5. The four states, as two visual languages

This is the section that protects principle 2. [Phase 2](phase-02-architecture.md) §5 fixed the
taxonomy; here it becomes pixels.

| Kind | Language | Treatment | Says | Offers |
|---|---|---|---|---|
| `refused` | **Policy** | Bordered block, neutral-accent, policy icon. Not red | `customerMessage` (ADR 0007) | Escalate, or the stated alternative |
| `stale` | **Policy** | Same block | "This is no longer possible — the order has now shipped" | Escalate |
| `malformed` | **Policy** | Same block, generic copy | "I couldn't complete that request" | Escalate |
| `fault` | **Fault** | Error banner, warning colour, retry affordance | "Something went wrong on our side" | Retry |

**The rule: three of the four are not errors.** Only `fault` uses error styling. A refusal is a
correct outcome of a working system and is styled as information with consequence, not as
breakage.

**Every policy-language block ends in a next step.** A refusal that dead-ends is a product bug
(ADR 0007), so the escalate affordance is part of the component, not something each caller
remembers to add.

**Agents see more.** In the console the same block additionally renders `internalReason` — rule
key, version, matched conditions — in a separate, visually subordinate detail area. Two
channels, one component, audience decided by role (ADR 0007).

---

## 6. Agent console

Three panes on desktop:

```
┌────────────┬───────────────────────────┬──────────────────┐
│  QUEUE     │  TRANSCRIPT               │  CONTEXT         │
│            │                           │                  │
│ filter by  │  full conversation        │ proposed reply   │
│ state      │  citations inline         │  → send / edit   │
│            │  tool results as cards    │  → discard       │
│ open   12  │  policy blocks with       │                  │
│ assigned 4 │    internalReason         │ blocked actions  │
│ waiting  7 │                           │  + deciding rule │
│ resolved 3 │                           │                  │
│            │                           │ ticket state     │
│            │                           │  legal moves     │
└────────────┴───────────────────────────┴──────────────────┘
```

**Ticket transitions: only legal moves are rendered.** The state machine (FR-9.1) drives the
control, so `open → closed` is not offered. The server still rejects it (FR-9.2) — the UI
narrowing the options is convenience, never enforcement, and both exist on purpose.

**Blocked actions are a primary panel, not a log.** The console's most valuable view is *what
the assistant wanted to do and why it couldn't*, which is the same information the audit
exposes in aggregate.

**Proposed replies are never auto-sent.** Send, edit, or discard — all explicit (FR-10.4).

---

## 7. Policy rules screen

**Baseline and tenant rules are visually separated** (ADR 0008). Baseline rules render read-only
with a platform badge and a line explaining they cannot be relaxed — which pre-empts the
predictable confusion of a lead writing a permissive rule that loses to the baseline.

**The editor is generated from the condition registry** ([Phase 3](phase-03-database-design.md)
§5.2). Field is a select; the operator list is derived from the chosen field's type; the value
input is typed to match — an enum select for `order.status`, a currency-aware number input for
`order.totalMinor`. **An invalid rule is not authorable**, which is a stronger guarantee than
validating one after it is written.

`customerMessage` is a **required** field with a live preview of exactly what a customer would
see. Writing the human-facing sentence is part of writing the rule, not an afterthought
(ADR 0007), and the preview makes that concrete.

The outcome ladder renders in order with plain-language descriptions rather than raw enum
values — *"a human agent may do this; the assistant may not"* rather than `agent-only`.

---

## 8. Accessibility (NFR-8)

**The confirmation dialog** carries the full spec from ADR 0009: `role="alertdialog"`, focus
trapped, heading focused on open (not the confirm button), `Escape` dismisses, focus restored to
the trigger, both buttons labelled with their outcome.

**Streaming and screen readers.** Piping tokens into an `aria-live` region as they arrive
produces continuous interruption and is unusable. Instead: a polite status region announces
*"Assistant is responding"* and *"Response complete"*, and the message content itself is
readable as static text once the turn finishes. Announce the *state*, not the *stream*.

**Throughout:** visible focus rings that are never removed without replacement; every control
labelled; colour never the sole carrier of meaning — the policy and fault languages differ in
icon, border and copy, not only in hue; `prefers-reduced-motion` honoured for streaming
animation and modal transitions; the queue navigable by keyboard with a skip link past it into
the transcript.

**Contrast:** WCAG AA minimum throughout, including the policy-block accent, which is the
element most likely to be styled into low-contrast subtlety.

---

## 9. Visual language

Design tokens and primitives are **ported from Project 2** — colour scale, type scale, spacing,
radii, elevation, and the button, input, dialog and badge primitives. Not redesigned. The third
product in a series looking like the second is a feature.

Project-specific additions, all of which exist to serve §5:

- **Policy block** — the bordered block for refusals, with its own accent that is deliberately
  not the error colour.
- **Evidence card** — structured tool results and citation chunks.
- **Outcome badge** — the seven terminal outcomes, colour plus label, used in the audit and the
  console.
- **Rule reference** — a compact `ruleKey · v2` chip, internal surfaces only, never customer-facing.

---

## 10. Responsive

**Customer conversation is mobile-first.** Customers arrive on phones; the confirmation modal
must work at 360px, where a full-screen sheet with the same seven ADR 0009 properties replaces
the centred dialog.

**Agent console is desktop-first**, three panes collapsing to a stack below 1024px with tab
navigation. It is a work tool used at a desk, and pretending otherwise would compromise the
desktop layout for a case that will not happen.

---

## 11. What Phase 4 did not decide

- **Component implementation** — Phase 5. This is the design; the React components are built
  when the frontend foundation is laid.
- **Exact copy strings** — drafted alongside the baseline rules, since `customerMessage` is rule
  data (ADR 0007), not UI text.
- **Dark mode** — tokens support it (ported), but it is not an MVP commitment.
- **Empty, loading and skeleton states** for the console — Phase 5, no correctness content.
- **The hygiene sweep interval** for expiring pending proposals — Phase 10.

---

*Phase 4 complete. Phase 5 lays the frontend foundation: Vite + React, the ported token system,
routing, the auth shell, and the streaming transport — the first phase with running code, and
the first that CI can actually check.*
