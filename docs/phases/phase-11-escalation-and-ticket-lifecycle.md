# Phase 11 — Escalation and the ticket lifecycle

**Project 3 · AI Support Desk**
Status: **complete.** Delivers FR-8 (escalation) and FR-9 (ticket lifecycle), and the ticket routes
and console behind FR-10. What none of it has yet run against — a replica set, a real API — is
listed in §7, and what it deliberately leaves open in §11.

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

**Out, stated at the start rather than discovered at the end:**

- **FR-10.4 — send, edit or discard a proposed reply.** Nothing drafts agent replies: there is no
  drafting endpoint, and live inference does not run on this machine. FR-10's own scope note allows
  the console to ship without it.
- **An agent writing to the customer.** The conversation screen shows only what it streamed
  itself; it cannot receive a message sent later. A ticket can be worked, but the agent cannot yet
  answer the customer from the console.
- **The policy-rules and audit screens.** Their APIs shipped in Phase 10, and the traceability
  table gives their screens no build phase. The `App.jsx` placeholders had said "Phase 11", because
  the Phase 10 conversation-screen commit relabelled them without checking; they now say no phase
  is scheduled (§6).

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
execution, the action service records a terminal `failed` outcome, and its comment explained why:
*"so an agent looks rather than the proposal silently hanging."* Nothing made an agent look — and
because the outcome is terminal, the customer could not retry either. A request that had gone
wrong was a dead end on both sides. It now escalates with reason `execution_failed`, in the same
transaction as the `failed` row. If that row cannot be written at all, nothing is escalated, and
nothing stops the customer trying again.

---

## 4. Escalation commits with its cause

An automatic escalation is written inside the transaction of the record that caused it: the
outcome row, or for a malformed proposal the proposal row. `mongoTicketRepo.applyEscalation` never
opens a transaction of its own; the action repository calls it within its own. So:

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
| `PolicyBlock` headed every policy notice "This needs a person", promising a colleague whether or not one was coming | §8 |
| `App.jsx` labelled the policy and audit placeholders "Phase 11" | `App.jsx` |

---

## 7. Honestly unverified

As in Phase 10, the first three need a MongoDB **replica set**, and none has run against one:

- that the partial unique index really admits one active ticket per conversation;
- that an outcome and its ticket really commit or abort together;
- that `withTransaction`'s automatic retry re-runs the escalation callback safely;
- the escalation screens and the console against the real API. Every browser check in §10 used a
  `fetch` stub inside the page.

The repository tests assert which writes share a session, the conditions on each write, and how
each lost race is handled. They do not, and are not described as, proving what MongoDB does.

---

## 8. The customer's side

**Only the server can say a colleague is coming.** The conversation reducer marks a conversation
escalated in exactly three ways: a policy notice flagged `escalated: true`, an error flagged the
same way, or the escalate route answering success. Only then does the screen say "A colleague will
pick this up". Pressing "Talk to a person" escalates nothing by itself: the button shows the
request in flight, and the words change only when the answer arrives. A failed request claims
nothing and can be tried again.

**What is offered, and where.** A refusal the rule explained offers a person, and pressing it sends
that refusal's proposal id, which the server verifies before recording `policy_refused`. An answer
the AI service could not ground offers a person beside it. The heading offers one at any time once
a conversation exists. An escalated notice offers nothing, because the person is already coming.

**`PolicyBlock` no longer promises anything by default.** Its old heading for every policy notice,
"This needs a person", and its fallback texts promised a colleague whether or not one was coming.
Headings now name the situation ("This can't be done here", "This is no longer possible"), and a
colleague appears in the heading or the fallback only when `escalated` is set. A fault that the
server escalated as terminal offers no retry, because retrying could not work.

**No promise of a reply.** The notice says a colleague "can see this conversation" and stops there,
because an agent cannot yet write back through this screen (§1).

---

## 9. The agent console

- **The queue (FR-10.1).** The filter lives in the address bar, so a filtered queue survives a
  reload and can be shared. Every status shows its count, "Active" is everything not closed, and
  paging is by cursor, oldest first. A filter the server does not recognise is a 422 there; in the
  address bar it simply shows the default queue.
- **A ticket (FR-10.2, FR-10.3).** The transcript; every attempted action with the exact rule
  version that decided it, its internal reason and the sentence the customer was told (ADR 0007's
  two channels, side by side); the event history; and the moves.
- **Only legal moves are rendered, from the server.** Each ticket arrives with `legalMoves` taken
  from the state machine, and the console renders those and nothing else, so `open → closed` is
  never offered. The server still refuses anything else (FR-9.2). A move lost to another agent is a
  409, shown as "Someone else moved this ticket first", with a reload.

---

## 10. Verification

**Tests.** Server **455** (+100), client **115** (+39), AI service **78** (unchanged). Every new
guarantee has a test, and the Phase 10 ones still pass — including the ADR 0009 dialog properties,
since the customer screen changed around the dialog.

**In the browser.** The real client on the Vite dev server, with `fetch` stubbed inside the page,
because no API can run here without a replica set.

- *Customer.* A refusal arrived as a notice headed "This can't be done here", with the rule's own
  words and a "Talk to a person" button, and nothing on the page mentioned a colleague. Pressing it
  sent `{"proposalId":"p9"}`. While the request was in flight, both "Talk to a person" buttons were
  disabled and `aria-busy`, and still nothing claimed a colleague. After the answer the notice was
  headed "A colleague will pick this up", the page notice appeared, the status region announced it,
  and no button remained.
- *Agent.* "/" redirected to the queue, which showed each status's count with "Active" current.
  The ticket view showed the transcript, the dispatched-order attempt with its rule version,
  internal reason and customer sentence, the malformed attempt with its problem code, and the
  history. An open ticket offered only "Take ticket". Taking it showed the button busy, then the
  ticket as Assigned with "Wait for customer" and "Mark resolved", a history reloaded with "Taken",
  and an announcement in the status region. At 375px the panes stack and the page does not scroll
  sideways.

Two notes from the browser run. Each console page requested its data twice on first load: the app
is wrapped in `StrictMode`, which runs effects twice **in development only**, and each effect's
cancellation flag discards the first response. And screenshots timed out because the app window
was hidden, so the evidence above was read from the page rather than from images.

---

## 11. What Phase 11 leaves open

- **An agent cannot answer the customer** from the console, and the customer's screen could not
  show it if they did (§1). The ticket lifecycle works; the conversation it is about does not
  continue through the product.
- **FR-10.4, proposed replies**, has nothing to propose them (§1).
- **The escalate route has no rate limit.** At most one active ticket per conversation bounds the
  tickets, but each call appends an event. Phase 12 (security) is where that belongs.
- **The demo seed creates no tickets**, so a freshly seeded console is empty until something
  escalates.
- **The policy-rules and audit screens** remain unscheduled.
