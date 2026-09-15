# Escalation eval

Does the assistant hand the right conversations to a person? Phase 1 §6 and §7.3; ADR 0010.

```bash
python -m evaluation.run                   # the report, at the configured threshold
python -m evaluation.run --tune            # choose a threshold on `tune`, judge it once on `holdout`
python -m evaluation.run --check           # exit 1 if a number drifted from baseline.json
python -m evaluation.run --write-baseline  # after a deliberate change
```

It needs the full `requirements.txt` (sentence-transformers, chromadb). It embeds the real help
centre with the real model into a temporary Chroma directory and takes about a minute on a CPU.

## Why it needs no language model

Phase 1 planned this eval against recorded fixtures, on the assumption that it needed a live model,
which this machine cannot run. It does not. Whether a turn escalates is decided in `plan_turn`
**before any text is generated**: a request to act goes to the policy engine, a grounded question
is answered, and an ungrounded one is offered a person. Measuring that needs the embedding model,
which runs on a CPU. So this eval ran for real, and its numbers come from the shipping code path.

## The labelled set

There are 44 single-turn messages in `dataset.py`, each labelled by reading the three articles in
`data/kb`. The split is fixed and committed, and every kind appears in both halves.

| Kind | Turns | Examples |
|---|---|---|
| answerable | 16 | "Do you deliver on Sundays?" |
| needs a person | 10 | "My parcel is five days late", "I was charged twice" |
| out of scope | 8 | "What is the capital of France?", and traps that share the help centre's words: "cancel my gym membership", "return a library book" |
| mentions cancelling | 10 | requests with and without an order number, and messages that are not requests: "Don't cancel order 1043" |

Two labels matter most and are kept separate: **`kb_covers`** (the help centre has the information)
and **`needs_person`** (an answer does not solve the customer's problem). They come apart: the
help centre does say what to do about a late parcel, but only a person can open the investigation.

## Metrics

| Metric | Of which turns | Failure it counts |
|---|---|---|
| Wrongful deflection rate | needs a person | answered, nobody offered. **The metric Phase 1 §6 names** |
| Unnecessary offer rate | answerable | offered a person instead of an answer. Fails safe |
| False answer rate | out of scope | answered from the help centre anyway |
| False proposal rate | every non-request | a proposal raised. Should be exactly 0 |
| Missed request rate | requests | not proposed, or not asked which order |
| Grounding balanced accuracy | not requests | grounding compared with `kb_covers` |

## Results

The model is all-MiniLM-L6-v2, top_k is 5, and the index has 7 chunks.

| | at 0.35 (inherited from Project 1) | **at 0.51 (tuned, applied)** |
|---|---|---|
| Wrongful deflection | 0.600 (6 of 10) | **0.300** (3 of 10) |
| Unnecessary offers | 0.000 (0 of 16) | **0.312** (5 of 16) |
| False answers | 0.250 (2 of 8) | **0.000** (0 of 8) |
| False proposals | 0.000 (0 of 37) | **0.000** |
| Missed requests | 0.143 (1 of 7) | **0.143** |
| Grounding balanced accuracy | 0.788 | **0.818** |
| Expected article retrieved first | 1.000 | 1.000 |

**Tuning.** The threshold was selected on the 17 tuning turns (balanced accuracy 0.864), then
checked once on the 17 held-out turns. There, balanced accuracy went from 0.742 at 0.35 to 0.773 at
0.51. The margin is about one turn, so the evidence is thin. It was applied because the method was
fixed before the numbers were seen, and because the trade runs the safe way: harmful mistakes fell
from 8 to 3, while mistakes that fail safe rose from 0 to 5.

**What no threshold can fix.** The three customers still deflected at 0.51 score *higher* than most
answerable questions:

- "Tracking says delivered but there is nothing here": 0.610
- "My parcel is five days late": 0.594
- "My refund still hasn't arrived after two weeks": 0.577

A threshold high enough to offer a person for all three would also offer one for 11 of the 16
answerable questions. Similarity measures whether the help centre is *about* a message, not whether
an answer *resolves* it. Reducing wrongful deflection further needs a second signal, such as a
conservative recogniser for reports of a problem, like the one for requests to act. It is not built
here. A recogniser written and scored against these same 44 turns would be tuned to the eval.

**The recogniser.** It raises no proposal for any message that is not a request. It misses one
request, "Could you cancel the order I placed yesterday?", because it knows "can you" but not "could
you". The miss fails safe: the customer is answered and nothing is proposed.

## What runs where

- **Every push** (`tests/test_escalation_eval.py`, no model): the recogniser raises no false
  proposal over the whole set, and a new missed request fails the suite. The dataset and metric
  maths are checked, and the harness is run with the test fakes.
- **Weekly and on demand** (`.github/workflows/eval.yml`): this report with the real model, failing
  if any number drifts from `baseline.json` by more than 0.02. It is deterministic, but not a merge
  gate, because installing torch and a model is minutes most changes do not need.

## What it does not cover

As Phase 1 §7.4 requires:

- **No generated text is measured.** A grounded answer can still be a wrong answer. The words the
  model writes are not scored, because no model can run here.
- **Single turns only.** History is passed empty, so it does not test a request made across two
  messages, or manipulation over several turns.
- **No adversarial prompt injection**, whether in the customer's message or planted in the help
  centre.
- **Small, and labelled by the builder.** The same person wrote the help centre, the recogniser
  and the labels. 44 turns detect large changes, not small ones, and no real customer transcripts
  were available.
- **English only**, and **three articles**. A larger help centre changes the score distribution,
  and the threshold would need re-tuning.
