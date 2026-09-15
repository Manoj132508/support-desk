# Phase 11 — Escalation and the ticket lifecycle

**Project 3 · AI Support Desk**
Status: **in progress.** Delivers FR-8 (escalation) and FR-9 (ticket lifecycle), and the ticket
routes and console behind FR-10. This document records findings as they are made rather than
reconstructing them at the end.

---

## 1. Scope

**In:**

- **FR-8, escalation**, by ADR 0010's three cases, with every automatic escalation committed in the
  same transaction as the record that caused it.
- **FR-9, the ticket lifecycle**: conditional transitions over the append-only `TicketEvent` log.
- **The ticket routes** from Phase 6 §3.4, and a route for a customer to ask for a person.
- **The customer's side**: "Talk to a person", and policy notices that say truthfully whether a
  colleague is already coming.
- **An agent console**: a queue filterable by state, and a ticket view with the transcript, every
  attempted action with the rule version that decided it, the event history, and only the legal
  moves.

**Out, stated now rather than discovered later:**

- **FR-10.4 — send, edit or discard a proposed reply.** Nothing drafts agent replies: there is no
  drafting endpoint, and live inference does not run on this machine. FR-10's own scope note allows
  the console to ship without it.
- **An agent writing to the customer.** The conversation screen shows only what it streamed
  itself; it cannot receive a message sent later. A ticket can be worked, but the agent cannot yet
  answer the customer from the console. That is a real gap in the product, and it is recorded as
  one.
- **The policy-rules and audit screens.** Their APIs shipped in Phase 10, and the traceability
  table gives their screens no build phase. The `App.jsx` placeholders say "Phase 11" only because
  the Phase 10 conversation-screen commit relabelled them without checking (§6).

---

## 2. Before building

Integrity first, as in Phase 10: `git fsck` clean, the working tree clean, and every suite green —
server 355, AI service 78, client 76.

---

## 3. Four documents disagreed about when to escalate

FR-8.2 names three triggers. Phase 2 §3.2 escalates after refusals and after a customer's own
rejection too. Phase 4 §5 has refusals *offer* escalation. ADR 0007 has a message-less refusal
escalate. Read literally they cannot all hold, and the Phase 10 screen was already telling
customers "I'll bring in a colleague" with nothing behind the sentence.

[ADR 0010](../adr/0010-escalation-automatic-offered-or-none.md) settles it with three cases:

| Case | When |
|---|---|
| **Automatic** | `agent-only` at proposal or execution · a malformed proposal · a refusal with no customer message · a terminal execution failure |
| **Offered** | a refusal with the rule's own message · an answer the AI service could not ground · any time the customer asks |
| **None** | the customer's own decisions · expiry · states the customer can retry |

The rule underneath is ADR 0002's shape again: **only the deterministic tier escalates on its
own.** The AI service's `shouldEscalate` can put an offer in front of the customer; it cannot
create a ticket.

**A fourth automatic case was found in the code, not the documents.** On a fault during
execution, the action service records a terminal `failed` outcome, and its comment explains why:
*"so an agent looks rather than the proposal silently hanging."* Nothing made an agent look — and
because the outcome is terminal, the customer could not retry either. A request that had gone
wrong was a dead end on both sides. It now escalates with reason `execution_failed`, in the same
transaction as the `failed` row. If that row cannot be written at all, nothing is escalated, and
nothing stops the customer trying again.

---

## 4. Escalation commits with its cause

An automatic escalation is written inside the transaction of the record that caused it: the
outcome row, or for a malformed proposal the proposal row. `mongoTicketRepo.applyEscalation`
never opens a transaction of its own; the action repository calls it within its own. So:

- no `escalated_at_proposal`, `refused_at_execution` or `failed` row that escalates exists without
  its ticket;
- the customer is told a colleague is coming only after the ticket exists — the result, the stream
  frame and the error envelope all carry `escalated`, set only from what was committed;
- if the ticket cannot be written, the outcome is not written either, and the request faults.

The action service decides *whether* (a pure function, `automaticEscalationReason`); the
repositories decide *how*. Both are tested separately, and the fake repository enforces the same
all-or-nothing rule as the transaction, so the service's tests can see it.

---

## 5. The ticket model, and what Phase 3 left out

- **One active ticket per conversation** (FR-8.3's "creates or updates"). `Ticket.active` is true
  until the ticket closes, and a partial unique index on `(tenantId, conversationId)` over active
  tickets enforces the rule. Two first escalations racing each other cannot both create a ticket:
  the loser's duplicate key is retried once, finds the winner's ticket, and appends to it.
- **How a writer picks the next `seq`.** Phase 3 made `seq` monotonic and unique, but not how the
  next value is chosen, and "read the last event, add one" races. `Ticket.lastEventSeq` is
  incremented in the same conditional update that changes the ticket, and the event takes the new
  value.
- **Every ticket write is conditional** on the status it was planned from. A manual transition that
  loses to another agent is reported as a 409 asking for a reload — not retried, because the agent
  needs to see where the ticket now is.
- `TicketEvent` gains `proposalId`, so the console can link an escalation to the attempt behind it,
  and two reasons: `proposal_malformed` and `execution_failed`. `low_confidence` stays in the enum
  unused: the server has no verified fact to record it from.
- An index for the default queue — active tickets, oldest first.

---

## 6. Corrections to earlier phases

| Correction | Recorded in |
|---|---|
| Phase 2 §3.2 escalates after every refusal and every rejection | ADR 0010 |
| A terminal execution failure promised "an agent looks", and nothing did | ADR 0010, §3 |
| `POST /api/tickets/:id/escalate` could not serve a customer, who has no ticket before escalating and may not read tickets | Replaced by `POST /api/conversations/:id/escalate`, customer only |
| The error envelope gains `escalated`, because a refusal at execution arrives as a 409 | `errorEnvelope.js`, ADR 0010 |
| Phase 3 did not say how the next `TicketEvent.seq` is chosen | §5, `Ticket.lastEventSeq` |
| `App.jsx` labelled the policy and audit placeholders "Phase 11" | `App.jsx` |

---

## 7. Honestly unverified

As in Phase 10, everything below needs a MongoDB **replica set**, and none has run against one:

- that the partial unique index really admits one active ticket per conversation;
- that an outcome and its ticket really commit or abort together;
- that `withTransaction`'s automatic retry re-runs the escalation callback safely.

The repository tests assert which writes share a session, the conditions on each write, and how
each lost race is handled. They do not, and are not described as, proving what MongoDB does.

---

## 8. Still to build in this phase

- The customer's side of the conversation screen: "Talk to a person", and escalated notices.
- The agent console: the queue, and the ticket view with its legal moves.
- A browser check of both.
