# ADR 0011 — A small help centre is sent whole, in a fixed order, in the system message

- **Status:** Accepted
- **Date:** 2026-09-16 (Phase 14)
- **Satisfies:** NFR-1 · **Preserves:** INV-C
- **Relates to:** [ADR 0006](0006-append-only-audit-retains-refusals.md) (citations are references),
  [Phase 14](../phases/phase-14-performance.md)

## Context

NFR-1 asks for the first streamed token within 2.5 s at p95 on the development machine. Phase 14
measured the shipped pipeline end to end: `llama3.2:3b` running on an i5-4590, CPU only, because the
machine's GPU faults.

Everything around the model was fast. Proposals, handoffs and requests for an order number reached
their first token in 41–77 ms. Answers took **9.0 s at p50 and 38.4 s at p95**. The AI service's
per-turn log showed where the time went:

- **Reading the prompt.** Every answer's prompt was 962–1,041 tokens, and the CPU reads about 48
  tokens a second: 8.5–21.7 s per question.
- **Loading the model.** The first answer after a start also waited 16.2 s. Ollama unloads an idle
  model after five minutes, so this recurs.
- **Repeated questions were different.** A question asked twice reached its first token in 0.55 s.
  Ollama reuses its reading of any prompt start it has already read.

The prompt builder already put its sources first "where prompt caching can reuse it". The sources
were in score order, though, and two different questions rank the same chunks differently. The
prompts diverged at the first source, and nothing after the system prompt was ever reused.

## Options measured

Each shape was tried directly against Ollama with the real embeddings and eight different
answerable questions from the escalation eval.

| Shape | Prompt tokens | First token, p50 | Max | Expected article cited | Answers wrong |
|---|---|---|---|---|---|
| Top 5, score order (shipped) | ~1,007 | 8.5 s | 16.6 s | 6/8 | 0 |
| Top 5, fixed order | ~1,007 | 1.0 s | 15.0 s | — | — |
| Only chunks above the threshold | ~588 | 0.9 s | 12.0 s | — | — |
| Whole help centre, fixed order | ~1,288 | 0.79 s | 1.16 s | 5/8 | **1** |
| **Whole help centre, fixed order, relevant sources named** | ~1,300 | ~1.2 s | 1.4 s | **7/8** | **0** |

Two results were not what one would guess:

- **A shorter prompt did not help much.** Trimming to the chunks above the threshold halved the
  tokens, but the prompts still differed from one question to the next, so most of each was read
  from scratch.
- **The longest prompt was the fastest.** Once every prompt starts identically, the model reads that
  start once; after that, each question costs only its own words.

Sending everything in help-centre order had a cost. On "The courier came twice while I was out",
the model merged two different sections into one wrong claim, and it cited a neighbouring article
for "Can personalised items be returned?". Relevance is no longer shown by position. One line naming
the relevant sources by number, just before the question, restored both answers.

Placement mattered for conversations. With the sources in the user message, conversation history
sits between the system prompt and the sources, so they start at a different place in every
conversation. A follow-up turn's prompt then took **23.7 s** to read. With the sources in the
system message, ahead of history, it took **1.9–2.3 s**. Answer quality in that placement was again
7/8 with none wrong.

## Decision

**While the indexed help centre has at most `full_context_max_chunks` chunks (default 10), an
answer's prompt is:**

1. **System:** the rules, then every chunk, numbered in help-centre order (article, then position).
2. **The conversation history,** as before.
3. **User:** "The sources most relevant to this question are [n], [m]." (the chunks that cleared
   the grounding threshold, most relevant first), then the question.

**Above that size, the prompt is exactly what it was:** the top chunks in score order, in the user
message. That is the only shape whose quality was measured for a large help centre, which this
project does not have.

**Grounding is still decided by retrieval, before any prompt exists (INV-C).** An ungrounded
question is never sent the help centre, and the threshold, the score and the escalation signal are
unchanged. A proposal still cites the most relevant chunks, not every chunk.

**Citations follow the order the model saw,** so every `[n]` it writes has a footnote. The client
lists the sources an answer cites, numbered as its markers are, rather than every source it was
given.

**The model is kept warm.** Every request asks Ollama to keep the model loaded (`keep_alive`,
default 30 minutes). At startup, and after the help centre is re-indexed, the service primes the
model with the shared start of every prompt, in the background and never fatally.

## Consequences

- **Measured:** see [Phase 14](../phases/phase-14-performance.md) for NFR-1 end to end before and
  after.
- **Every answer's prompt is longer,** about 1,300 tokens instead of about 1,000. That costs memory
  and model context, not time, once the start has been read.
- **The model holds its memory** for `keep_alive` after the last turn: 2.6 GB for `llama3.2:3b`.
- **Reuse depends on the serving process keeping its cache.** A second process, a restart, or
  enough concurrent conversations to evict the cached start means paying the read again. This was
  measured with one Ollama process and turns one at a time.
- **The quality evidence is a spot check by the builder:** eight questions and three two-turn
  conversations with a 3B model, not an eval. Generation quality has no eval in this project
  (Phase 13 §6). The limit and the fallback exist because the evidence does not reach further.
- **`full_context_max_chunks` is a guess** at where a whole help centre stops being small. 10 chunks
  of at most 800 characters is about 2,000 tokens. A larger help centre needs this measured again,
  not assumed.
