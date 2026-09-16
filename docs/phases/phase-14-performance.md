# Phase 14 — Performance

**Project 3 · AI Support Desk**
Status: **complete.** Delivers NFR-1 (time to first streamed token) and NFR-2 (policy evaluation
latency), measured on the development machine. What was not measured, or does not meet its target,
is in §10.

---

## 1. Scope

| NFR | Requirement | Target |
|---|---|---|
| NFR-1 | Time to first streamed token | p95 < 2.5 s on the dev machine, measured and reported honestly, not aspirationally |
| NFR-2 | Policy evaluation latency | < 10 ms; in-process deterministic code, never a network call |

Phase 1 §6 also asks for time to first token to be "instrumented in the streaming path". The
method followed Project 2's performance work: measure where the time goes, then change only what the
numbers point at.

---

## 2. Before building

`git fsck` was clean and the working tree was clean. The suites stood at server 524, client 136 and
AI service 105.

**The measurement machine** was an i5-4590 with 4 threads and 16 GB of DDR3, running Windows 11 and
Node 24.19. The rest of the stack ran on the same machine:

- **Database:** MongoDB 8.3.8, as a single-node replica set, with a separate `ai-support-desk-perf`
  database so benchmark data never mixed with the demo data.
- **AI service:** real `all-MiniLM-L6-v2` embeddings and Chroma, using Project 1's Python
  environment, which has the same library versions.
- **Model:** `llama3.2:3b` in Ollama, **CPU only** (`AI_NUM_GPU=0`, confirmed by `ollama ps`
  showing "100% CPU"), because the GPU faults (Phase 1 §8). It was the only model already
  downloaded; the configured default, `llama3.1:8b`, was not measured (§10).
- **Client path:** requests went through the Vite dev proxy on 5179, as a browser's do.

`AI_MAX_TOKENS=120` shortened each answer so runs finished sooner. It does not affect time to first
token, which comes before any of those tokens.

---

## 3. NFR-2 — policy evaluation

`npm run perf:policy` times the real engine one call at a time: every decision case in the policy
eval's golden set against the seeded rules, then the same engine with thousands of extra rules
written to force the worst case per rule (every condition read, none matching).

| Rule set | Rules | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| **Golden-set decisions, seeded rules** (50,000 calls) | 5 | 1.6 µs | 2.2 µs | **2.9 µs** | 359 µs |
| + 100 worst-case rules | 105 | 129 µs | 161 µs | 297 µs | 2.5 ms |
| + 1,000 worst-case rules | 1,005 | 1.2 ms | 1.5 ms | 1.7 ms | 5.7 ms |
| + 5,000 worst-case rules | 5,005 | 6.4 ms | 7.1 ms | 7.6 ms | 14.3 ms |

**Met, about 3,400 times under budget at p99.** Evaluation is linear in rules, at roughly 1.3 µs per
worst-case rule, so p99 would reach 10 ms near 6,500 rules. The maximums include garbage-collection
pauses.

It is **reported, not gated**: a timing is not a deterministic invariant (Phase 1 §6). The half of
NFR-2 that is deterministic is gated. The engine imports nothing but its vocabulary and reads no
clock (Phase 10's tests), and it returns its decision synchronously, so it cannot be waiting on a
network (`test/perfStats.test.js`).

---

## 4. Instrumenting the streaming path

Each turn now logs one line on each side of the process boundary. The two lines share a correlation
id, and neither contains the customer's words (NFR-4).

**Express (`turn_timing`).** The clock starts when the request arrives, so authentication (a
database read on every request) and rate limiting are included. It marks when:

- the question was persisted;
- the stream opened;
- the AI service responded;
- the first frame, the first token and the last frame reached the customer.

**AI service (`turn_timing`).** It records the time to plan (intent check, embedding, search), the
first token, and the end. When the model was called, it adds Ollama's own breakdown: model load,
prompt tokens, prompt reading time, and generation.

**The harness** (`npm run perf:ttft`) drives the running stack as a customer does:

- It signs in as seeded customers and sends a fixed mix of answered questions, handoffs, proposals
  and requests for an order number.
- Two answers get a follow-up question in the same conversation.
- Each kind is reported separately. Pooled, fast static turns would hide slow answers.
- It refuses any host but localhost, because it uses the seed's published password.

---

## 5. NFR-1 — the baseline

The shipped code ran two rounds of the mix, 18 turns, starting from a cold start.

| Kind | n | p50 | p95 | NFR-1 |
|---|---|---|---|---|
| Answered (calls the model) | 10 | 9.02 s | **38.37 s** | misses |
| Offered a person | 4 | 54 ms | 75 ms | meets |
| Proposal | 2 | 47 ms | 49 ms | meets |
| Asked for an order number | 2 | 41 ms | 77 ms | meets |

The pipeline around the model was never the problem. Planning took 12 to 40 ms, and a static turn's
first token reached the customer within 80 ms. The AI service's lines showed what an answer waited
for:

- **Loading the model.** The first answer after a start waited 16.2 s. Ollama unloads an idle model
  after five minutes, so this recurs.
- **Reading the prompt.** Every answer's prompt was 962 to 1,041 tokens, roughly the whole help
  centre, since `top_k` is 5 of its 7 chunks. The CPU reads about 48 tokens a second: **8.5 to
  21.7 s per question.**
- **Except for a repeat.** A question asked a second time reached its first token in about 0.55 s.
  Ollama reuses its reading of any prompt start it has read before.

The prompt builder's own docstring put the sources first "where prompt caching can reuse it across
turns". **That reuse never happened.** The sources were in score order, which differs from one
question to the next, so prompts diverged at the first source.

---

## 6. What was tried, and what shipped

Every option was measured before any code changed: directly against Ollama, with the real
embeddings, eight different answerable questions from the escalation eval, and answer quality
checked by reading each answer.

| Prompt shape | Tokens | First token p50 | Max | Right article cited | Wrong answers |
|---|---|---|---|---|---|
| Top 5, score order (shipped) | ~1,007 | 8.5 s | 16.6 s | 6/8 | 0 |
| Top 5, fixed order | ~1,007 | 1.0 s | 15.0 s | — | — |
| Only chunks above the threshold | ~588 | 0.9 s | 12.0 s | — | — |
| Whole help centre, fixed order | ~1,288 | 0.79 s | 1.16 s | 5/8 | **1** |
| **Whole help centre, fixed order, relevant sources named** | ~1,300 | ~1.2 s | 1.4 s | **7/8** | **0** |

Four results decided the design:

1. **A shorter prompt barely helped.** Trimming halved the tokens, but prompts still differed, so
   most of each was read from scratch.
2. **The longest prompt was the fastest.** When every prompt starts identically, the model reads
   that start once, and each question costs only its own words.
3. **Fixed order cost accuracy, and one line bought it back.** Without relevance order, the model
   merged two sections into a wrong answer about missed deliveries. A line naming the relevant
   sources by number fixed it.
4. **Where the sources sit decides whether conversations benefit.** With the sources in the user
   message, history lands in front of them. A follow-up turn's prompt took **23.7 s** to read,
   against **1.9 to 2.3 s** with the sources in the system message, where quality was again 7/8
   with no wrong answers. A harness sending first turns only would never have shown this, so the
   harness now sends follow-ups.

**Shipped** ([ADR 0011](../adr/0011-prompt-shape-for-prompt-reuse.md)):

- **A small help centre is sent whole.** While the index has at most `full_context_max_chunks` (10)
  chunks, every chunk goes into the system message in help-centre order, and the question names the
  sources that cleared the threshold.
- **A larger help centre keeps the old prompt exactly,** because that is the only shape whose
  quality was measured at that size.
- **Grounding is unchanged.** Retrieval decides it before any prompt is built (INV-C), and an
  ungrounded question is never sent the help centre.
- **Citations follow the order the model saw,** so every `[n]` has a footnote. The client lists
  only the sources an answer cites, numbered as its markers are (`lib/citedSources.js`).
- **The model is kept warm.** Every request carries `keep_alive` (30 minutes). At startup, and after
  re-indexing, the service primes the model with the shared start of every prompt, in the
  background and never fatally. Measured at startup: 34.1 s (6.9 s to load, 26.8 s to read 1,275
  tokens). That cost used to fall on the first customer.

---

## 7. NFR-1 — after

The same machine and turn mix, now with follow-ups, after a restart and the warm-up. 22 turns.

| Kind | n | Before p50 / p95 | **After p50 / p95** | NFR-1 |
|---|---|---|---|---|
| Answered, first turn | 10 | 9.02 s / 38.37 s | **1.76 s / 1.96 s** | **meets** |
| Answered, follow-up | 4 | ~23.7 s ¹ | **2.23 s / 2.74 s** | **misses by 0.24 s** |
| Offered a person | 4 | 54 ms / 75 ms | 64 ms / 138 ms | meets |
| Proposal | 2 | 47 ms / 49 ms | 51 ms / 64 ms | meets |
| Asked for an order number | 2 | 41 ms / 77 ms | 45 ms / 47 ms | meets |

¹ The follow-up's prompt reading time under the old placement, from the experiment in §6; the
baseline run had no follow-ups.

**Where an answer's time goes now:**

| Stage | Time |
|---|---|
| Express's part (arrival to relaying the first token) | ~20 ms |
| Planning in the AI service | 13–27 ms |
| Reading the prompt, first turn | 0.74–1.47 s |
| Reading the prompt, follow-up (new history plus question) | 1.84–2.38 s |

**Verdict.** NFR-1 is met on this CPU for every turn that does not call the model, and for answers
that start a conversation. It is **not met for follow-up answers**, which miss by 0.24 s at p95.
That is from four samples, so the p95 is simply the slowest one. They still read their history
from scratch. Removing that would mean changing the relevance line whose quality was just checked,
for about 0.4 s. It was not done inside a performance phase without the same check.

---

## 8. The database — query plans

Phase 3 declared the indexes and Phase 7 asserted the declarations, but neither could say whether
MongoDB uses them. `perf/queryPlans.js` explains each hot query in the shape the code runs it,
against the replica set, and reports the index chosen, keys and documents examined against
documents returned, and any collection scan or in-memory sort.

| Query | Index used | Result |
|---|---|---|
| Authenticate (every request), sign-in, conversation, history window, transcript | `_id_`, `slug_1`, `tenantId_1_email_1`, `tenantId_1_conversationId_1_createdAt_1` | examined = returned |
| Propose: order by number, orders in 90 days, idempotency key, proposal-time decision | the designed index each time | examined = returned |
| Audit (newest attempts), sweep (pending proposals) | `tenantId_1_createdAt_-1__id_-1` | sort provided by the index |
| **Console queue, active / one status** | `tenantId_1_active_1_openedAt_1` / `…currentStatus…` | **sort in memory** |
| Policy rules for tenant plus baseline, **with 200 other tenants' rules added** | `tenantId_1_ruleKey_1_version_1` | 6 keys, 5 documents, 5 returned |

**Fixed: the queue sorted every matching ticket in memory.** It sorts on `(openedAt, _id)`, and its
indexes ended at `openedAt`. Both indexes now end in `_id`, and the plan has no sort stage. An
existing database gains the new indexes when the API starts, but keeps the superseded pair until
`syncIndexes` runs. That is a deployment step for Phase 15.

**Suspected, measured, and wrong.** The rules lookup's filter leads with `actionType`, and so does
its obvious index, so I expected it to read every tenant's rules. With 200 other tenants present,
the planner instead chose the unique index that leads with `tenantId`, and examined 5 documents.
No change was made.

---

## 9. Found on the way

| Finding | Fixed by |
|---|---|
| **Health never asked the AI service.** The probe was a placeholder left for Phase 9 and never built, so health reported `unreachable` whenever a URL was set, even while the service answered turns | `probeAiService`: a real request with a 1.5 s timeout, so a hung service cannot hang health |
| **Copying `.env.example` stopped the AI service at import.** `AI_NUM_GPU=` was an empty string where an integer was required | Empty variables mean unset (`env_ignore_empty`); a test loads every `AI_` setting from `.env.example` |
| **The escalation eval read `citations[0]` as the best match.** Answer citations now follow help-centre order | The harness takes the best score; a test fails against the old harness |
| **The first harness measured first turns only,** which would have hidden the 23.7 s follow-up | Follow-ups, reported separately |
| **The first query-plan reader read rejected plans too,** and reported three in-memory sorts that never ran | It reads only the winning plan; a test fails against the old reader |

---

## 10. Honestly unverified, and deferred

- **`llama3.1:8b`, the configured default, was not measured.** It isn't downloaded, and at more than
  twice the parameters it reads prompts more slowly on a CPU. The NFR-1 numbers are for
  `llama3.2:3b`.
- **No GPU measurement.** The GPU faults.
- **Turns were sent one at a time.** Concurrent conversations, and whether they evict each other's
  cached prompt start in Ollama, were not measured.
- **`plan_turn` runs on the AI service's event loop:** 13 to 27 ms during which other streams wait.
  That is small beside the model; the fix is a thread pool, deferred.
- **Follow-up answers miss NFR-1** by 0.24 s at p95 (§7).
- **The samples are small:** 10 first-turn answers and 4 follow-ups, so each p95 is the slowest
  sample.
- **The quality evidence for ADR 0011 is a spot check** of eight questions and three conversations
  with a 3B model, judged by the builder. Generation quality has no eval (Phase 13 §6).
- **A customer arriving during the 34 s startup warm-up** waits for part of it. That was not
  measured.
- **`full_context_max_chunks = 10` is an estimate.** No help centre larger than 7 chunks was
  measured.
- **Measured through the Vite dev proxy,** not a production build behind real hosting (Phase 15).
- **`ActionProposal.model.latencyMs`** exists in the schema and is never written. Recorded, not
  changed.
- **The client's source list was verified by a page test and by reading real frames,** not by
  looking at it in a browser, which would have meant typing a password.

---

## 11. Verification

**Tests.** Server **556** (+32), AI service **131** (+26), client **144** (+8). Every fix in §8 and
§9 has a test. These were also run against the old code and seen to fail: the queue indexes, the
example environment file, the eval harness's best match, the plan reader's rejected plans, and the
client's cited sources. The health probe's tests were not: the old code had no probe to call, so they
could only fail at import.

**Measurements**, rerunnable with the scripts above:

- NFR-2 benchmark: §3.
- Time-to-first-token harness, before and after: §5 and §7.
- Prompt-shape experiments and quality spot checks: §6.
- Query plans, including 200 synthetic tenants: §8.

The experiment scripts were one-off and live outside the repository; their results are recorded
here and in ADR 0011.

**On the real stack**, the AI service's health is `ok` for the first time. An answer's evidence
arrives numbered 1 to 7, and its citation `[6]` resolved to the returns article, the correct source.
