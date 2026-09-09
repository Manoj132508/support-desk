# ADR 0009 — Confirmation is a deliberate modal, and friction is the feature

- **Status:** Accepted
- **Date:** 2026-09-09 (Phase 4)
- **Answers:** Phase 1 open question 1
- **Satisfies:** FR-6, NFR-8 · **Supports:** INV-A
- **Relates to:** [ADR 0002](0002-llm-proposes-never-authorises.md),
  [ADR 0007](0007-two-channel-refusal-reasons.md)

## Context

INV-A requires "an explicit confirmation of the exact, fully-resolved action before it
executes". Phase 1 left the surface open: inline in the conversation stream, or a modal?

The stakes are higher than they look. **This is the single UI element the entire invariant
depends on.** Everything upstream — the trust boundary, the policy engine, the re-check, the
audit — exists to funnel a decision to this control. A confirmation the customer clicks through
without reading converts all of that work into theatre. The architecture cannot be undermined
from the backend at this point; it can only be undermined here.

**Inline** keeps conversational flow and feels modern: a card in the transcript with a button.
It is also visually adjacent to a dozen other buttons, scrolls like ordinary chat content, and
sits exactly where a user has been trained to click quickly.

**Modal** interrupts. It is the pattern users associate with "this one matters". It is also the
pattern users have been trained to dismiss reflexively by a decade of cookie banners, and a
badly built one is worse than inline because it invites `Enter` to mean yes.

The deciding argument: this project's thesis is that consequential actions deserve deliberate
authorisation. A UI optimised for flow at this exact moment would contradict the thing being
demonstrated. **"Harder to click through by accident" is not a cost here. It is the feature.**

## Decision

**A focus-trapped modal**, with the following non-negotiable properties. Each exists to close a
specific way a confirmation can become meaningless.

**1. Verb-specific button labels. Never "OK" / "Cancel".**

The MVP action is *cancelling an order*. A dialog with a **Cancel** button is catastrophically
ambiguous — "Cancel" plausibly means *cancel the order* or *cancel this dialog*, and the two
are opposite outcomes. Buttons name their outcome:

> **Cancel order #1043**  ·  **Keep my order**

This generalises: every action's confirmation labels both buttons with what they do, never with
a generic affirmative and negative.

**2. The confirm button is not focused on open.** Focus lands on the dialog heading. `Enter` on
an unfocused dialog does nothing. A muscle-memory `Enter` from the message box cannot authorise
an action.

**3. The action text is rendered from the stored proposal, never from model output** (FR-6.1),
and is visually distinct from assistant prose — a bordered block in a different type treatment,
so it cannot be confused with something the model said. What is displayed is stored on the
outcome record as `confirmedText` (Phase 3 §4), which is how "the UI showed the real action"
becomes provable rather than intended.

**4. Dismissal is not a decision.** `Escape` and backdrop click close the dialog and leave the
proposal **pending** — the action reappears as an inline card in the transcript, re-openable.
Only pressing **Keep my order** records `rejected_by_customer`. The distinction between *I
declined* and *I did not decide* is real and is preserved in the audit.

**5. Nothing times out into consent** (FR-6.2). The dialog has no countdown and no auto-action.
Pending proposals are swept by a hygiene job to a new terminal outcome, `expired` — which is a
non-execution like every other non-execution.

**6. Fully keyboard operable** (NFR-8): focus trapped within the dialog, `Tab` cycles, `Escape`
dismisses, focus returns to the triggering element on close, `role="alertdialog"` with the
action text as the accessible description.

**7. One proposal, one dialog.** Never a queue of stacked confirmations. If a second proposal
arrives while one is open, it waits as an inline card.

## Consequences

**Positive**

- The moment that matters is deliberate, and the design says so.
- Verb-specific labels remove the worst ambiguity in the product's flagship interaction.
- The audit can prove what the customer was shown, not just what they clicked.
- Pending / rejected / expired stay distinguishable, so the audit reflects what actually
  happened rather than flattening three different customer behaviours into one.

**Negative**

- Modals interrupt, and interrupting is a real experience cost. Accepted deliberately, and only
  for side-effecting actions — informational answers never open one.
- Not focusing the confirm button makes the fast path slower for a confident user. That is the
  intended trade.
- More states to build: pending, dismissed-but-pending, expired.
- Modals are the harder pattern to make accessible. Mitigated by treating the focus-trap
  behaviour as a tested requirement rather than a styling detail.

**Neutral**

- The agent console reuses the same component for agent-initiated actions, so the guarantees
  hold on both surfaces without a second implementation.

## Alternatives considered

**Inline confirmation card in the transcript.** Better flow, no interruption. Rejected: it
places the most consequential control in the visual position users click fastest, and it scrolls
away. If the modal proves genuinely painful in use, the fallback is an inline card that *still*
keeps properties 1–6 — the properties matter more than the container.

**Type-to-confirm** (retype the order number). Maximum deliberateness. Rejected as
disproportionate for cancelling an order, and it punishes the customer for the system's
uncertainty. Reasonable for a future irreversible action; noted, not adopted.

**Second-factor or re-authentication.** Rejected for the same proportionality reason. The
customer already holds an authenticated session, and the risk being managed is *the model
acting wrongly*, not *the customer being impersonated*.

**Confirm button focused by default.** Rejected explicitly, because it is the default in most UI
libraries and will be re-introduced by accident unless it is written down as forbidden.

## Verified by

- Test: `Enter` immediately after the dialog opens does not execute.
- Test: `Escape` leaves the proposal pending; no outcome row is written.
- Test: **Keep my order** writes `rejected_by_customer`.
- Test: the rendered action string equals the string persisted as `confirmedText`.
- Test: focus is trapped, and returns to the trigger on close.
- Test: no confirmation button label is "OK", "Cancel", "Yes", or "No".
