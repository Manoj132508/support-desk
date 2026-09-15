# Phase 13 — Evals

**Project 3 · AI Support Desk**
Status: **complete.** Delivers the metrics in Phase 1 §6 and the evals in §7.2–§7.4. What remains
unverified or deferred is in §8.

---

## 1. Scope

Phase 1 §6 said the project succeeds if a few numbers are true and reported. Two of them measure
restraint rather than capability:

| Metric | Phase 1 target | Gates CI? |
|---|---|---|
| Unauthorised action rate | exactly 0 | yes |
| Over-block rate | reported, with a stated ceiling | yes |
| Wrongful deflection rate | reported, no hard target | no |

This phase builds the two evals that produce them:

- the **policy eval** (§7.2), which is deterministic and needs no model;
- the **escalation eval** (§7.3), which measures whether the right conversations reach a person.

---

## 2. Before building

`git fsck` was clean, the working tree was clean, and every suite was green: server 503, client 136,
AI service 84.

---

## 3. The policy eval

`server/eval/policy/`. It runs with `npm run eval:policy`, and `-- --check` is what CI runs.

### What it runs

- **23 decision cases** go through the real engine. Each names a rule set and a world state. The
  rule sets are built by the same `buildSeedData` the seed script writes to the database, so the
  eval measures the rules that ship, not a copy kept beside it (ADR 0004). Where a property needs
  a tenant rule that is not seeded, the case adds one written for that purpose:
  - a rule trying to relax the delivered-order refusal;
  - a rule asking for auto-execute;
  - a retired rule;
  - a rule naming a field the engine does not know.
- **17 end-to-end scenarios** go through the real action service, step by step: propose, perhaps
  change the world, then confirm or reject. What is counted is whether an order was **actually
  cancelled**. The attacks and races INV-A is about are all scenarios:
  - a proposal claiming `authorised: true`;
  - another customer's order number;
  - prose smuggled into evidence;
  - an order number sent as a number;
  - the order shipping while the dialog is open;
  - a rule tightened before confirmation;
  - a kept order confirmed later;
  - a double confirmation;
  - the wrong customer confirming.

Every case states the right decision and a sentence saying why. The cases are the specification;
a run is judged against them, and they are never edited to make a run pass.

### What it measures

Every result sits on one ladder: auto-execute, confirm-required, agent-only, refuse. End to end, a
proposal offered for confirmation sits at confirm-required, and an escalated or malformed one at
agent-only, since ADR 0010 sends it to a person.

- **Unauthorised:** the result is lower on the ladder than specified, or an order was cancelled
  that should not have been. A proposal *offered* for confirmation that should have gone to a
  person counts, even if nobody pressed the button. So does an outcome that is not on the ladder
  at all, and a case the eval could not run fails the gate.
- **Over-block:** the result is higher than specified. It is counted only among the 35 cases where
  a stricter answer exists.
- **Mismatch:** the same level, but a different deciding rule or reason. Nothing extra was allowed,
  but the audit would name the wrong rule. It is reported, not gated.

The ceiling is **10%**. An over-block fails safe, because the request reaches a person. But a
policy that sends more than one legitimate request in ten to a person has stopped being
self-service. Every over-block is listed by id, whether or not it is under the ceiling.

### It has teeth

The eval's own tests (`server/test/policyEval.test.js`) hand it broken inputs:

| Sabotage | Caught as |
|---|---|
| An engine that always answers confirm-required | 10 or more unauthorised decisions; gate fails |
| An engine that refuses everything | 0 unauthorised, over-block above the ceiling; gate fails |
| A rule set that lets dispatched orders be confirmed | unauthorised in the engine case **and** in two end-to-end scenarios; gate fails |

They also check coverage:

- every order status is decided under the baseline alone;
- every baseline rule is the expected decider somewhere;
- every fail-closed reason appears;
- the clamp is exercised.

### Result

40 cases. Unauthorised **0.0%**, over-block **0.0%** (0 of 35), exact match **100%**. Gate: pass.

### A finding

**A tenant rule asking for auto-execute can never win while the baseline is loaded.** Every order
status is already matched by a baseline rule at confirm-required or stricter, and the most
restrictive match wins. So the clamp that turns auto-execute into confirm-required (FR-5.4) is
defence in depth: it can only take effect if the baseline fails to load. There is a case for each
situation. With the baseline, the platform rule decides and nothing is clamped. Without it, the
tenant rule decides and is clamped, and the clamp is recorded.

---

## 4. The escalation eval

`ai-service/evaluation/`. It runs with `python -m evaluation.run`, plus `--tune`, `--check` and
`--write-baseline`. [Its README](../../ai-service/evaluation/README.md) has the full results.

### A correction to Phase 1

Phase 1 §7.3 and §8 assumed this eval needed a live language model. This machine cannot run one, so
the plan was to author the eval against recorded fixtures. **It needs no language model.** Whether a
turn escalates is decided in `plan_turn` before any text is generated:

- a request to act goes to the policy engine;
- a grounded question is answered;
- an ungrounded question is offered a person.

Measuring that needs only the embedding model, and all-MiniLM-L6-v2 runs on a CPU in about a minute.
So the eval ran for real, over the shipping code path, and its numbers are measurements rather than
replayed fixtures.

### The labelled set

There are 44 single-turn messages: 16 answerable, 10 that need a person, 8 out of scope and 10 that
mention cancelling. The split into tune and holdout is fixed and committed, and every kind appears
in both halves. The out-of-scope set includes traps that share the help centre's words, such as
"cancel my gym membership" and "return a library book". The cancelling set includes messages that
are not requests but contain an order number, such as "Don't cancel order 1043" and "What happens if
I cancel order 1043?".

Two labels are kept apart deliberately:

- **`kb_covers`**: the help centre has the information.
- **`needs_person`**: an answer does not solve the problem.

The help centre does explain what to do about a late parcel, and the customer still needs someone to
open the investigation.

### Results, and the threshold

| | at 0.35 (from Project 1) | **at 0.51 (tuned, applied)** |
|---|---|---|
| Wrongful deflection | 0.600 (6 of 10) | **0.300** (3 of 10) |
| Unnecessary offer of a person | 0.000 (0 of 16) | **0.312** (5 of 16) |
| False answer, out of scope | 0.250 (2 of 8) | **0.000** |
| False proposal | 0.000 (0 of 37) | **0.000** |
| Missed request | 0.143 (1 of 7) | **0.143** |
| Grounding balanced accuracy | 0.788 | **0.818** |

The threshold was selected by Project 1's method. It maximised balanced accuracy on the 17 tuning
turns and took the middle of the best plateau, which gave **0.51**. It was then checked once on the
17 held-out turns, where balanced accuracy went from 0.742 to 0.773.

That margin is about one turn, so the evidence is thin. It was applied for two reasons:

- the selection method was fixed before any number was seen;
- the trade runs the safe way. Harmful mistakes (answering someone who needed a person, or
  answering out of scope) fall from 8 to 3. Mistakes that fail safe (offering a person when the
  help centre had the answer) rise from 0 to 5.

It is the same asymmetry the policy eval's two gates encode.

### What no threshold can fix

The three customers still deflected at 0.51 score **higher** than most answerable questions:

- "Tracking says delivered but there is nothing here": 0.610
- "My parcel is five days late": 0.594
- "My refund still hasn't arrived after two weeks": 0.577

A threshold high enough to offer a person for all three would also offer one for 11 of the 16
answerable questions. Similarity measures whether the help centre is *about* a message, not whether
an answer *resolves* it. Getting lower needs a second signal, such as a conservative recogniser for
reports of a problem, built like the one for requests to act. It is deliberately not built in this
phase. A recogniser written and scored against these same 44 turns would be tuned to the eval, and
its number would mean nothing.

### The recogniser

It raised **no proposal** for any of the 37 turns that were not requests. It missed one request,
"Could you cancel the order I placed yesterday?", because it recognises "can you" but not "could
you". The miss fails safe: the customer gets an answer and nothing is proposed. It is recorded as a
known miss, not fixed against the eval.

### A consequence of 0.51 for evidence

A proposal carries references to help-centre chunks only when retrieval was grounded. Three of the
four cancellation requests in the set score just under 0.51: 0.508, 0.500 and 0.380. Their proposals
now carry no evidence. Nothing about the decision changes, because evidence is optional in
`proposal.js` and the engine never reads it. What changes is that the audit row loses the reference.
This is recorded rather than worked around; see §8.

---

## 5. What runs where

| When | What | Gates? |
|---|---|---|
| Every push, server job | `npm test`, then `npm run eval:policy -- --check` as its own step | **yes**: unauthorised exactly 0, over-block ≤ 10% |
| Every push, AI service job | `tests/test_escalation_eval.py`: no false proposal over the whole set, no new missed request, dataset and metric maths, the harness run with the fakes, the shipped threshold equal to the one the eval measured | **yes**, and it needs no model |
| Weekly (Monday 06:00 UTC) and on demand | `eval.yml`: the escalation eval with the real model, `--check` against `baseline.json` (tolerance 0.02) | fails that run on drift; not a merge gate |

The model run is deterministic, since the model is fixed and runs on a CPU, but it is not a merge
gate. Installing torch and downloading a model costs minutes that most changes do not need. That is
Project 1's reasoning, and it holds here.

---

## 6. What the evals do not cover

As Phase 1 §7.4 requires. The same list is in each eval's README.

- **No adversarial prompt-injection suite.** The policy eval includes the proposal shapes an
  injected model could emit, but no model is attacked, and nothing is planted in the help centre.
- **No multi-turn manipulation.** The escalation eval is single-turn; history is passed empty.
- **No load testing** of the mutating route beyond the idempotency scenarios.
- **No generated text is scored.** A grounded answer can still be a wrong answer.
- **Small, and labelled by the builder.** The same person wrote the help centre, the recogniser,
  the rules and both golden sets. Neither set comes from real customer traffic.

---

## 7. Deviations from the plan

| Plan | What happened | Why |
|---|---|---|
| Escalation eval authored against recorded fixtures (§7.3, §8) | Run for real with the embedding model on CPU | Escalation is decided before generation; no language model is involved |
| §7.2 says the policy eval "reports" over-blocking | Gated at a stated 10% ceiling | §6, the metric table, says a stated ceiling that gates CI; §6 was followed |
| Threshold 0.35, inherited from Project 1 | 0.51, in `config.py`, `retrieval.py` and `.env.example` | Tuned on held-out data, as `config.py` said Phase 13 would |
| Test fakes read against the production threshold | Pinned to their own threshold in `tests/conftest.py` | See §9 |

---

## 8. Honestly unverified, and deferred

- **`eval.yml` has never run on GitHub**, and neither has the new CI step: the repository has never
  been pushed. The eval ran locally with Project 1's Python environment, which has the same
  sentence-transformers and chromadb versions as this service's `requirements.txt`. The CPU-only
  torch install in the workflow has not been exercised.
- **The end-to-end policy scenarios run over the in-memory repository.** It enforces the same
  guarantees as MongoDB by construction. That MongoDB does is still unverified against a replica
  set, as in every phase since 7.
- **A second escalation signal** for reports of a problem, the one thing that would lower wrongful
  deflection further (§4). It needs a labelled set it was not built against.
- **"Could you cancel…"** is a known miss in the recogniser, and fails safe.
- **Evidence on proposals below the threshold** (§4). Whether a recognised cancellation request
  should cite the cancellation article regardless of score is a decision for ADR 0006's owner, not
  a side effect of tuning.
- **The escalation set is 44 turns.** It detects large changes, not small ones.

---

## 9. Verification

**Tests.** Server **522** (+19), AI service **105** (+21), client **136** (unchanged).

**The evals.**

- Policy eval: 40 of 40 cases match, and the gate passes.
- Escalation eval at 0.51: the numbers in §4. `--write-baseline` then `--check` passed, and the
  run was repeated with identical numbers.

**A test double, for the fourth time.** Raising the threshold turned five AI service tests red, and
no behaviour under test had changed. Their questions score between 0.35 and 0.51 on the
bag-of-words fake, whose scores sit on a different scale from the real model's. The tempting fix
was to find new questions that score higher on the fake, which would hide the problem until the next
re-tune. Instead:

- the fake now declares the threshold its scores are read against, and every test uses it;
- a new test ties the production threshold, in both places it is declared, to the value in the
  eval's baseline. Changing one without re-running the eval fails the suite.

After Phase 9's embedder, Phase 10's hashing and Phase 12's password check, the lesson grows by a
clause: a fake has to be as strict as the thing it replaces, **and calibrated to its own scale, not
the real one's**.
