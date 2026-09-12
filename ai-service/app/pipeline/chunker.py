"""Deterministic, page-aware document chunking.

WHY CHUNK AT ALL
----------------
Three reasons, in order of how load-bearing they are:

1. **The embedding model truncates.** all-MiniLM-L6-v2 accepts 256 tokens.
   Longer input is silently cut -- no error, no warning -- so embedding a
   50-page PDF whole would represent only its first paragraph and pages 2-50
   would not exist as far as retrieval is concerned. This is a correctness
   constraint, not an optimisation.

2. **Dilution.** The output is 384 floats regardless of input length. One
   paragraph produces 384 numbers describing that paragraph; fifty pages
   produce the same 384 numbers averaging every topic in the document. That
   pulls every document toward a generic centre, so precision does not
   degrade gracefully -- it collapses.

3. **Citations.** If the unit of retrieval is a document, the most precise
   citation possible is "somewhere in this 50-page PDF".

(The classic fourth reason -- "it will not fit in the context window" -- is
largely obsolete at a 1M-token context. What still holds is that you pay for
every irrelevant page, and models attend less reliably to material buried in a
huge context than to a short focused one.)

DETERMINISM
-----------
The same input must always produce byte-identical chunks with identical ids.
Chunk ids are ``{document_id}:{index}`` (ADR 005), so a non-deterministic
chunker would silently orphan vectors on every re-index.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from dataclasses import dataclass

# Tried in order. Earlier separators are more semantically meaningful, so the
# splitter only falls back to a cruder boundary when a coarser one leaves a
# piece too large. The empty string is not listed: an unbreakable run is hard
# split as a last resort, which is handled explicitly.
DEFAULT_SEPARATORS: tuple[str, ...] = ("\n\n", "\n", ". ", "? ", "! ", "; ", " ")

# Joins pages into one continuous document. Counted in offsets, so page
# mapping stays exact.
PAGE_SEPARATOR = "\n\n"


@dataclass(frozen=True)
class Page:
    """One page of extracted text. ``number`` is 1-indexed, as a reader counts."""

    number: int
    text: str


@dataclass(frozen=True)
class Chunk:
    text: str
    index: int
    char_start: int
    char_end: int
    page_start: int
    page_end: int

    @property
    def page(self) -> int:
        """The page a citation points at.

        A chunk may span a page boundary. It is attributed to the page it
        STARTS on, because that is where a reader looking for the quoted
        passage should begin. ``page_end`` is kept so a citation can say
        "pages 12-13" when it genuinely spans two.
        """
        return self.page_start


def _split_keeping_separator(text: str, start: int, separator: str) -> list[tuple[str, int]]:
    """Splits after each separator, keeping it attached to the preceding piece.

    Keeping the separator matters for two reasons: offsets stay exact (the
    pieces tile the source with no gaps), and rejoining reproduces the original
    text rather than a version with the punctuation stripped out.
    """
    pieces: list[tuple[str, int]] = []
    previous = 0

    for match in re.finditer(re.escape(separator), text):
        end = match.end()
        pieces.append((text[previous:end], start + previous))
        previous = end

    if previous < len(text):
        pieces.append((text[previous:], start + previous))

    return pieces


def _atomise(
    text: str, start: int, separators: tuple[str, ...], max_length: int
) -> list[tuple[str, int]]:
    """Breaks text into pieces no longer than ``max_length``, recursively.

    Returns (piece, absolute_offset) pairs that tile the input exactly.
    """
    if len(text) <= max_length:
        return [(text, start)]

    for position, separator in enumerate(separators):
        pieces = _split_keeping_separator(text, start, separator)
        if len(pieces) <= 1:
            continue  # this separator does not occur; try a cruder one

        atoms: list[tuple[str, int]] = []
        for piece_text, piece_start in pieces:
            # Only finer separators remain for the recursion, which is what
            # stops it retrying a boundary that already failed.
            atoms.extend(_atomise(piece_text, piece_start, separators[position + 1 :], max_length))
        return atoms

    # No separator occurs at all -- a long unbroken run such as a base64 blob
    # or a language without spaces. Hard split, so the model never receives
    # something it would truncate.
    return [(text[i : i + max_length], start + i) for i in range(0, len(text), max_length)]


def _overlap_tail(current: list[tuple[str, int]], overlap: int) -> list[tuple[str, int]]:
    """Builds the trailing region of a chunk to repeat at the head of the next.

    Whole atoms are preferred, because a fragment cut mid-sentence embeds
    worse than a clean one.

    BUT WHOLE ATOMS ALONE ARE NOT ENOUGH, and getting this wrong is silent. If
    every atom is larger than the overlap budget -- which is the normal case,
    since a prose paragraph easily exceeds 150 characters -- then no atom ever
    fits and the tail comes back empty. Overlap would then be configured,
    documented, and simply never happen, with nothing to indicate it. The only
    symptom would be occasional unanswerable questions whose evidence
    straddled a boundary.

    So when no whole atom fits, the last one is sliced. The cut is advanced to
    the next word boundary so the repeated fragment does not begin mid-word.
    """
    if overlap <= 0 or not current:
        return []

    tail: list[tuple[str, int]] = []
    tail_length = 0
    for text, start in reversed(current):
        if tail_length + len(text) > overlap:
            break
        tail.insert(0, (text, start))
        tail_length += len(text)

    if tail:
        return tail

    # Fall back to a character slice of the final atom.
    text, start = current[-1]
    cut = max(0, len(text) - overlap)

    boundary = text.find(" ", cut)
    if boundary != -1 and boundary + 1 < len(text):
        cut = boundary + 1

    if cut >= len(text):
        return []

    return [(text[cut:], start + cut)]


def _pack(
    atoms: list[tuple[str, int]], max_length: int, overlap: int
) -> list[list[tuple[str, int]]]:
    """Greedily packs atoms into chunks, carrying an overlapping tail forward.

    WHY OVERLAP: a sentence that answers the question may straddle a boundary,
    leaving neither chunk containing the whole statement -- so neither embeds
    close to the question and the answer becomes unretrievable. Repeating the
    tail of each chunk at the head of the next means any span shorter than the
    overlap appears intact in at least one chunk.

    The cost is real: overlapping text is embedded and stored twice, so ~19%
    more vectors at 150/800.
    """
    chunks: list[list[tuple[str, int]]] = []
    current: list[tuple[str, int]] = []
    current_length = 0

    for atom in atoms:
        atom_length = len(atom[0])

        if current and current_length + atom_length > max_length:
            chunks.append(current)
            current = _overlap_tail(current, overlap)
            current_length = sum(len(text) for text, _ in current)

        current.append(atom)
        current_length += atom_length

    if current:
        chunks.append(current)

    return chunks


def _page_offsets(pages: list[Page]) -> tuple[str, list[int], list[int]]:
    """Joins pages into one document and records where each begins."""
    parts: list[str] = []
    starts: list[int] = []
    numbers: list[int] = []
    cursor = 0

    for page in pages:
        starts.append(cursor)
        numbers.append(page.number)
        parts.append(page.text)
        cursor += len(page.text) + len(PAGE_SEPARATOR)

    return PAGE_SEPARATOR.join(parts), starts, numbers


def chunk_pages(
    pages: list[Page],
    *,
    chunk_size: int = 800,
    chunk_overlap: int = 150,
    separators: tuple[str, ...] = DEFAULT_SEPARATORS,
) -> list[Chunk]:
    """Splits extracted pages into overlapping, page-attributed chunks.

    Chunks are produced across the whole document rather than per page, so a
    passage spanning a page break stays intact. Each chunk records the page it
    starts and ends on, which keeps citations exact without sacrificing that
    continuity.
    """
    if chunk_overlap >= chunk_size:
        # Otherwise the carried-forward tail is the entire previous chunk and
        # packing makes no forward progress.
        raise ValueError(
            f"chunk_overlap ({chunk_overlap}) must be smaller than chunk_size ({chunk_size})"
        )
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")

    usable = [page for page in pages if page.text.strip()]
    if not usable:
        return []

    document, page_starts, page_numbers = _page_offsets(usable)

    def page_at(offset: int) -> int:
        # bisect_right - 1 gives the last page beginning at or before offset.
        return page_numbers[max(0, bisect_right(page_starts, offset) - 1)]

    atoms = [
        atom for atom in _atomise(document, 0, separators, chunk_size) if atom[0].strip()
    ]

    chunks: list[Chunk] = []
    for group in _pack(atoms, chunk_size, chunk_overlap):
        text = "".join(piece for piece, _ in group)
        if not text.strip():
            continue

        char_start = group[0][1]
        char_end = group[-1][1] + len(group[-1][0])

        chunks.append(
            Chunk(
                text=text,
                index=len(chunks),
                char_start=char_start,
                char_end=char_end,
                page_start=page_at(char_start),
                # char_end is exclusive, so the last character is at end - 1.
                page_end=page_at(max(char_start, char_end - 1)),
            )
        )

    return chunks
