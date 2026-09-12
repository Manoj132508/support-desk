# Phase 9 — KB ingest and the AI service

**Project 3 · AI Support Desk**
Status: complete. **The first phase where a model appears at all**, and where ADR 0002's trust
boundary stops being a diagram.

**167 tests green** — 105 server, 39 client, **23 Python** (new).

---

## 1. What exists now

```
ai-service/
  app/
    config.py                 no secret defaults, and no database credential at all
    service.py                the advisory pipeline: retrieve → decide → generate
    main.py                   FastAPI: /health, /turn (SSE), /ingest
    pipeline/
      chunker.py              PORTED VERBATIM from Project 1
      retrieval.py            ported; grounding threshold + escalation signal
      prompt.py               ported; two rules added
      loader.py               NEW — markdown help-centre articles into sections
      embedder.py             sentence-transformers, lazily imported
      vector_store.py         Chroma, lazily imported
  data/kb/                    three seeded help-centre articles
  tests/                      23 tests, no model, no network

server/src/
  services/aiClient.js        the only thing that talks to the AI service
  services/sse.js             the relay, and the frame allowlist
  routes/conversations.js     create · read · streaming turn
```

---

## 2. What was ported, and what the port actually cost

Project 1's repo was open on disk, so this is a real port.

| File | Treatment |
|---|---|
| `chunker.py` | **Copied verbatim.** 283 lines, unchanged. |
| `retrieval.py` | Ported; one addition (§3.1) |
| `prompt.py` | Ported; two system-prompt rules added (§3.2) |
| `embedder.py`, `vector_store.py` | Ported in shape, same libraries and versions |

The chunker is the clearest case for reuse in the whole project. It is 283 lines of careful
work — deterministic ids, exact character offsets, overlap that *actually happens* rather than
being configured and silently skipped — and none of it is support-desk-specific. Rewriting it
would have produced a worse version of something already correct.

**What it cost to reuse rather than copy blindly:** Project 1 chunked PDFs, so its unit of
citation is a page, and `Page` is named for that. A help centre is markdown, and "page 3" means
nothing to a customer. Rather than fork the chunker, `loader.py` maps *sections* onto `Page`
objects — the chunker is really a text-tiling algorithm with an offset-to-region map, and it
does not care what a region is called. Fifty lines of adaptation instead of a second chunker to
keep in step.

---

## 3. Two places this diverges from Project 1

### 3.1 A refusal is now a handoff, not an ending

In Project 1, "I couldn't find this in your documents" was the end of the interaction, and that
was the honest answer.

Here it is not enough. **A support customer told "I couldn't find that" and left there has been
deflected** — they still have the problem they arrived with, and wrongful deflection is one of
the two failure modes this project exists to measure (Phase 1 §6). So `RetrievalResult` now
carries `should_escalate`, every ungrounded turn offers a person (FR-8.2), and the rate at which
that happens is what Phase 13's escalation eval measures.

### 3.2 Two new system-prompt rules — which enforce nothing

```
- You cannot change, cancel or refund anything yourself, and you must never
  tell a customer that you have done so or that you will.
- Never state or imply that an action has already happened.
```

These do **not** enforce INV-A, and the code comment says so. Nothing in a prompt can: the
invariant holds because this process has no write path to business data, so deleting the entire
prompt file would not let the model execute anything.

What they prevent is the model **lying about** the invariant. A model that says *"I've cancelled
that for you"* while the policy engine is refusing has not taken an unauthorised action — it has
told the customer something false, which produces the same complaint, the same lost trust, and
the same support ticket. **The architecture protects the order; the prompt protects the
sentence.** Being clear about which does which is the point.

---

## 4. The trust boundary, as code

`server/src/services/sse.js` relays the AI service's frames to the browser through an
**allowlist**:

```js
export const RELAYABLE_FRAMES = new Set(['token', 'evidence', 'done']);
```

A pass-through relay would work perfectly today and be a serious hole in three weeks. Phase 10
adds a `proposal` frame that **opens a confirmation dialog**. On that day, "forward whatever the
advisory tier sent" becomes "let the model open its own authorisation prompt" — precisely what
INV-A forbids.

So the list is closed now, while it is cheap, and `proposal` is **deliberately absent** until
Phase 10 builds the validation that must accompany it. A test asserts that absence, so adding
the frame without the validation fails the build.

The same reasoning governs evidence fields: only `kind`, `ref`, `n`, `documentName`, `section`
and `score` are relayed. If the AI service ever sent `text` or `snippet` — through a bug, a
refactor, or a prompt-injected response — forwarding it would put free text into the immutable
audit row written downstream, where it can never be scrubbed (ADR 0006 amendment). There is a
test that a snippet containing a card number does not reach the browser.

---

## 5. Why the Python suite needs no model

`retrieve()` takes an `Embedder` protocol; `stream_answer()` takes a `Generator` protocol. Those
seams were in Project 1's design, and they are why 23 tests run in **0.3 seconds** with no torch,
no model download and no network.

`sentence-transformers` and `chromadb` are imported **inside constructors**, not at module top
level. Importing any module in the service therefore costs nothing, and CI installs
`requirements-test.txt` — a deliberately smaller list — rather than two gigabytes of torch.

**The trade, stated plainly:** CI proves the pipeline's logic in seconds. It does not prove that
a real model embeds these documents usefully. That is an integration concern, and Phase 13's
eval is where it is measured.

### A test double that quietly invalidated its own suite

The fake embedder started as plain bag-of-words. With it, *"what is the capital of Peru"* scored
**0.48** against a help centre about deliveries — above the 0.35 threshold — purely on the words
*what, is, the, of*. Every grounding test passed, and three of them passed **for the wrong
reason**.

A real sentence embedder does not have that failure, because it represents meaning rather than
token overlap. The omission made the double unrepresentative of the thing it stands in for,
which is the one way a test double can invalidate a whole suite while looking green. Stop-word
filtering restores the property that matters: unrelated questions score low.

---

## 6. Honestly unverified

- **Live inference has not run.** The GPU CUDA fault (Phase 1 §8) still blocks it. Every
  generation test uses `ScriptedGenerator` and asserts on **what the model was shown** — the
  system prompt, the sources, their order — rather than on what a model said. That is the more
  stable assertion anyway, but it is not the same as having run one.
- **No real embedding has been computed.** `sentence-transformers` is not installed here.
  Whether these three articles chunk into a usefully searchable index is unmeasured until
  Phase 13.
- **The conversation routes need a database** and are untested end to end, like Phase 8's auth
  routes. The relay they depend on is fully tested; the persistence around it is not.
- **The 0.35 threshold is inherited from Project 1, not tuned for this corpus.** Phase 13 tunes
  it against a held-out set, exactly as Project 1 did. Until then it is a starting value, and
  calling it anything more would be a guess dressed as a measurement.

---

*Phase 10 is the core: read-only tools, the policy engine, propose → confirm → execute, and the
audit. It is the phase the whole project exists for, and the one that adds the `proposal` frame
this phase deliberately refused to relay.*
