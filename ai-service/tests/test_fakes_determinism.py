"""The test doubles must be deterministic ACROSS PROCESSES.

This suite once passed 23/23 and then failed 4/23 two days later on an
unchanged commit, because the fake embedder bucketed tokens with Python's
built-in `hash()`, which is salted randomly per process.

A within-process test cannot catch that. Inside one interpreter `hash()` is
perfectly stable, so any assertion that embeds the same text twice and
compares will pass every time -- including on the broken version. The only way
to observe the defect is to compare what DIFFERENT processes produce, so these
tests spawn interpreters with different PYTHONHASHSEED values.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

EMBED_SCRIPT = (
    "import json\n"
    "from tests.fakes import BagOfWordsEmbedder\n"
    "print(json.dumps(BagOfWordsEmbedder().embed_query('can I cancel an order before dispatch')))\n"
)

RETRIEVE_SCRIPT = (
    "import json\n"
    "from pathlib import Path\n"
    "from app.pipeline.loader import load_kb\n"
    "from app.pipeline.retrieval import retrieve\n"
    "from tests.fakes import BagOfWordsEmbedder, InMemoryVectorStore\n"
    "embedder, store = BagOfWordsEmbedder(), InMemoryVectorStore()\n"
    "chunks = load_kb(Path('data/kb'))\n"
    "store.upsert('kb', chunks, embedder.embed_documents([c.text for c in chunks]))\n"
    "result = retrieve(query='cancel an order', collection='kb', embedder=embedder, store=store)\n"
    "print(json.dumps({'grounded': result.grounded, 'top': result.top_score,\n"
    "                  'order': [c.chunk_id for c in result.chunks]}))\n"
)


def _run_with_seed(script: str, seed: str):
    env = {**os.environ, "PYTHONHASHSEED": seed}
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


# 0 and 4 are the seeds that failed the suite before the fix. They are kept
# deliberately, alongside arbitrary ones, so this test would have caught the
# exact regression it exists for.
SEEDS = ("0", "1", "4", "31337")


def test_the_fake_embedder_is_identical_across_hash_seeds():
    baseline = _run_with_seed(EMBED_SCRIPT, SEEDS[0])
    for seed in SEEDS[1:]:
        assert _run_with_seed(EMBED_SCRIPT, seed) == baseline, (
            f"PYTHONHASHSEED={seed} produced a different embedding -- the double is "
            "non-deterministic across processes"
        )


def test_retrieval_over_the_seeded_kb_is_identical_across_hash_seeds():
    # The embedding being stable is necessary but not the whole claim. What the
    # suite actually depends on is the grounding DECISION and the ranking, so
    # those are compared end to end as well.
    baseline = _run_with_seed(RETRIEVE_SCRIPT, SEEDS[0])
    for seed in SEEDS[1:]:
        assert _run_with_seed(RETRIEVE_SCRIPT, seed) == baseline, (
            f"PYTHONHASHSEED={seed} changed a grounding decision or the ranking"
        )
