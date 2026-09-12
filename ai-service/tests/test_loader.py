"""Ingest: sections, determinism, and the ids vectors are keyed by."""

from __future__ import annotations

from pathlib import Path

from app.pipeline.loader import chunk_document, load_kb, parse_article

KB = Path(__file__).resolve().parent.parent / "data" / "kb"

ARTICLE = """# Cancelling an order

Some preamble text that belongs to the article itself.

## Before dispatch

An order can be cancelled at any point before it is dispatched.

## After dispatch

Once dispatched it cannot be cancelled.
"""


def test_the_title_names_the_document_and_headings_name_sections():
    document = parse_article(Path("cancelling-an-order.md"), ARTICLE)
    assert document.name == "Cancelling an order"
    assert document.document_id == "cancelling-an-order"
    titles = [section.title for section in document.sections]
    # The preamble is kept under the article's own name rather than discarded --
    # short articles often put the whole answer there.
    assert titles == ["Cancelling an order", "Before dispatch", "After dispatch"]


def test_an_article_with_no_subheadings_is_one_section():
    document = parse_article(Path("simple.md"), "# Simple\n\nJust one block of text.")
    assert len(document.sections) == 1
    assert "one block" in document.sections[0].text


def test_chunks_carry_the_section_a_citation_needs():
    document = parse_article(Path("cancelling-an-order.md"), ARTICLE)
    chunks = chunk_document(document)
    assert chunks
    for chunk in chunks:
        assert chunk.document_name == "Cancelling an order"
        assert chunk.section, "every chunk must resolve to a citable section"


def test_chunk_ids_are_deterministic():
    # Ids are {document_id}:{index} and vectors are keyed by them. A
    # non-deterministic chunker would silently orphan every vector on each
    # re-index, and re-ingesting would accumulate duplicates instead of
    # upserting over itself.
    document = parse_article(Path("cancelling-an-order.md"), ARTICLE)
    first = [chunk.chunk_id for chunk in chunk_document(document)]
    second = [chunk.chunk_id for chunk in chunk_document(document)]
    assert first == second
    assert first[0] == "cancelling-an-order:0"


def test_the_seeded_help_centre_loads():
    chunks = load_kb(KB)
    assert chunks, "the seeded knowledge base should not be empty"
    documents = {chunk.document_id for chunk in chunks}
    assert documents == {
        "cancelling-an-order",
        "delivery-and-tracking",
        "returns-and-refunds",
    }


def test_loading_is_stable_across_runs():
    # sorted() over the glob is not cosmetic: filesystem order is not
    # guaranteed, and unstable ordering breaks the determinism the ids rely on.
    assert [chunk.chunk_id for chunk in load_kb(KB)] == [chunk.chunk_id for chunk in load_kb(KB)]


def test_no_chunk_exceeds_the_configured_size():
    # The embedding model truncates silently past its limit -- no error, no
    # warning. An oversized chunk would be half-represented in the index and
    # nothing would say so.
    for chunk in load_kb(KB, chunk_size=800, chunk_overlap=150):
        assert len(chunk.text) <= 800 + 150
