"""Builds the grounded prompt.

PORTED FROM PROJECT 1, with two additions specific to this project, both in the
system prompt and both marked below.

A pure function, deliberately: prompt construction is the part of a RAG system
most worth testing and least testable if it is tangled up with an HTTP client.
"""

from __future__ import annotations

from app.pipeline.retrieval import RetrievedChunk

REFUSAL_TEXT = "I couldn't find an answer to that in our help centre."

SYSTEM_PROMPT = f"""\
You are a customer support assistant. You answer questions using ONLY the \
numbered sources provided.

Rules:
- Use only information present in the sources. Do not use outside knowledge, \
even if you are confident it is correct.
- Cite the source number in square brackets after each claim, like [1]. A \
claim drawn from two sources cites both, like [1][3].
- If the sources do not contain the answer, reply with exactly: \
"{REFUSAL_TEXT}" and nothing else. Do not guess, and do not offer a partial answer \
assembled from loosely related material.
- Quote figures, dates and names exactly as they appear. Do not round, \
convert, or rephrase them.
- Answer in prose, briefly. Do not restate the question or describe the \
sources.
- You cannot change, cancel or refund anything yourself, and you must never \
tell a customer that you have done so or that you will. If they ask for an \
action, describe what you are proposing and say a confirmation will follow.
- Never state or imply that an action has already happened."""

# ── The last two rules are new in this project ─────────────────────────────
#
# They do NOT enforce INV-A. Nothing in a prompt can: the invariant holds
# because the AI service has no write path to business data, so deleting this
# entire file would not let the model execute anything (ADR 0002).
#
# What they do is stop the model LYING ABOUT the invariant. A model that says
# "I've cancelled that for you" while the policy engine is refusing the action
# has not taken an unauthorised action -- it has told the customer something
# false, which produces the same complaint and the same lost trust. The
# architecture protects the order; this protects the sentence.


def build_sources_block(chunks: list[RetrievedChunk]) -> str:
    """Renders retrieved chunks as a numbered list.

    Numbering is 1-based and matches the order of ``chunks``, so the model's
    "[2]" maps to ``chunks[1]`` with no lookup table. The document name and
    section are included because they let the model disambiguate two sources
    that say similar things -- and because a citation the user can act on needs
    them anyway.
    """
    lines: list[str] = []
    for position, chunk in enumerate(chunks, start=1):
        location = chunk.document_name
        if chunk.section:
            location += f" — {chunk.section}"
        lines.append(f"[{position}] ({location})\n{chunk.text.strip()}")
    return "\n\n".join(lines)


def canonical_order(chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
    """Chunks in help-centre order -- article, then position -- whatever their scores.

    ADR 0011. The same chunks always render in the same order, so two prompts
    built from them start with the same text, and the model can reuse its
    reading of it.
    """

    def key(chunk: RetrievedChunk) -> tuple[str, int]:
        document, _, index = chunk.chunk_id.rpartition(":")
        return (document, int(index) if index.isdigit() else 0)

    return sorted(chunks, key=key)


def build_user_message(question: str, chunks: list[RetrievedChunk]) -> str:
    """Assembles sources plus question.

    SOURCES FIRST, QUESTION LAST. Two reasons: the long, stable part of the
    prompt sits at the front where prompt caching can reuse it across turns,
    and instructions placed after a long context are followed more reliably
    than ones buried above it.

    Phase 14 measured that the first reason does not hold for this message:
    sources in score order differ from one question to the next, so nothing
    after the system prompt is ever reused. It remains the prompt for a help
    centre too large to send whole; see `build_whole_help_centre_system`.
    """
    return f"""Sources:

{build_sources_block(chunks)}

---

Question: {question}"""


def build_whole_help_centre_system(chunks: list[RetrievedChunk]) -> str:
    """The system prompt with the WHOLE help centre, in `canonical_order`. ADR 0011.

    Identical for every question and every conversation, so the model reads it
    once and reuses that reading. On the development machine's CPU that took an
    answer's first token from 8-17 s to about 1 s (Phase 14).

    In the SYSTEM message, not the user's: conversation history sits between the
    two, so sources in the user message start at a different place in every
    conversation. Measured, a follow-up turn's prompt then took 23.7 s to read,
    against about 2 s here.
    """
    return f"""{SYSTEM_PROMPT}

Sources:

{build_sources_block(chunks)}"""


def build_question_message(question: str, relevant: list[int]) -> str:
    """The only part of a whole-help-centre prompt that changes per question.

    `relevant` names, by number, the sources that cleared the grounding
    threshold. With the sources in help-centre order, their position no longer
    says which ones matter, and without this line a spot check found the model
    merging two unrelated sections into one wrong answer. With it, that answer
    was right.
    """
    hint = ""
    if relevant:
        hint = "The sources most relevant to this question are " + ", ".join(f"[{n}]" for n in relevant) + ".\n\n"
    return f"{hint}Question: {question}"


def build_history_messages(history: list[dict], limit: int = 3) -> list[dict]:
    """Trims prior turns to the most recent few.

    Included so follow-ups like "and what about the other one?" make sense.
    Deliberately bounded: history grows without limit, and an unbounded
    transcript both costs tokens and gradually crowds out the retrieved
    sources the answer is supposed to come from.

    Note what does NOT happen here -- retrieval still runs against the new
    question. The model must never answer from conversation history alone,
    because nothing in history carries a citation.
    """
    recent = [
        {"role": turn["role"], "content": turn["content"]}
        for turn in history
        if turn.get("role") in ("user", "assistant") and turn.get("content")
    ][-(limit * 2) :]

    # The first message must be from the user; a history window that happens to
    # start on an assistant turn would be rejected by most chat APIs.
    while recent and recent[0]["role"] != "user":
        recent.pop(0)

    return recent
