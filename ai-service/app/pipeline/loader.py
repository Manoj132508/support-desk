"""Loads help-centre articles and splits them into citable sections.

WHY THIS IS NOT A STRAIGHT PORT. Project 1 ingested PDFs, so its unit of
citation was a page, and `chunker.Page` is named for that. A help centre is
markdown, and "page 3" means nothing to a customer reading an article -- the
useful citation is "Returns and refunds — Cancelling an order".

The chunker itself is reused UNCHANGED. It is really a text-tiling algorithm
with an offset-to-region map bolted on, and nothing in it cares whether a
region is a page or a section. So this module maps sections onto `Page`
objects, and the chunker never knows the difference.

That is the honest shape of the reuse: the hard part (deterministic chunking
with exact offsets and overlap that actually happens) is inherited; the
domain-specific part is fifty lines written here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.pipeline.chunker import Chunk, Page, chunk_pages

# A markdown ATX heading at level 2 or deeper. Level 1 is the article title and
# is handled separately -- it names the document, not a section within it.
SECTION_HEADING = re.compile(r"^(#{2,6})\s+(.+?)\s*$", re.MULTILINE)
TITLE_HEADING = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class Section:
    index: int
    title: str
    text: str


@dataclass(frozen=True)
class Document:
    document_id: str
    name: str
    sections: list[Section]


@dataclass(frozen=True)
class IngestedChunk:
    """A chunk ready to embed, carrying everything a citation needs."""

    chunk_id: str
    document_id: str
    document_name: str
    section: str | None
    text: str


def parse_article(path: Path, text: str) -> Document:
    """Splits one markdown article into titled sections.

    The document id is the file stem, so it is stable across re-ingests and
    readable in a log. Chunk ids are `{document_id}:{index}` (Project 1's
    ADR 005), so a non-deterministic id here would silently orphan every vector
    on the next re-index.
    """
    title_match = TITLE_HEADING.search(text)
    name = title_match.group(1).strip() if title_match else path.stem

    headings = list(SECTION_HEADING.finditer(text))

    if not headings:
        body = text[title_match.end() :] if title_match else text
        return Document(path.stem, name, [Section(0, name, body.strip())])

    sections: list[Section] = []

    # Anything between the title and the first subheading is a preamble, kept
    # rather than discarded -- short articles often put the whole answer there.
    preamble_start = title_match.end() if title_match else 0
    preamble = text[preamble_start : headings[0].start()].strip()
    if preamble:
        sections.append(Section(len(sections), name, preamble))

    for position, heading in enumerate(headings):
        end = headings[position + 1].start() if position + 1 < len(headings) else len(text)
        body = text[heading.end() : end].strip()
        if body:
            sections.append(Section(len(sections), heading.group(2).strip(), body))

    return Document(path.stem, name, sections)


def chunk_document(
    document: Document, *, chunk_size: int = 800, chunk_overlap: int = 150
) -> list[IngestedChunk]:
    """Chunks one article, attributing each chunk to the section it starts in.

    Sections are handed to the chunker as `Page` objects with 1-based numbers,
    so a passage that runs past a subheading stays intact in one chunk -- the
    same property that made Project 1 chunk across page breaks rather than
    within them.
    """
    pages = [Page(number=section.index + 1, text=section.text) for section in document.sections]
    chunks: list[Chunk] = chunk_pages(pages, chunk_size=chunk_size, chunk_overlap=chunk_overlap)

    by_number = {section.index + 1: section.title for section in document.sections}

    return [
        IngestedChunk(
            chunk_id=f"{document.document_id}:{chunk.index}",
            document_id=document.document_id,
            document_name=document.name,
            section=by_number.get(chunk.page),
            text=chunk.text,
        )
        for chunk in chunks
    ]


def load_kb(directory: Path, **chunk_options) -> list[IngestedChunk]:
    """Loads every markdown article in a directory, in a stable order.

    `sorted` is not cosmetic: filesystem order is not guaranteed, and unstable
    ordering would make two ingests of identical content produce different
    results, which is exactly the determinism the chunk ids depend on.
    """
    chunks: list[IngestedChunk] = []
    for path in sorted(directory.glob("*.md")):
        document = parse_article(path, path.read_text(encoding="utf-8"))
        chunks.extend(chunk_document(document, **chunk_options))
    return chunks
