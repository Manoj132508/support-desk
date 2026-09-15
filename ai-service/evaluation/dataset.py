"""The labelled turns for the escalation eval. Phase 1 §7.3.

Each turn is one customer message, labelled by a person reading the three
help-centre articles in `data/kb`. Four labels, each answering a different
question:

- `kind`             how the turn is grouped in the report:
    answerable       the help centre answers it; nobody needs to be involved.
    needs_person     resolving it needs someone to DO something, or to know
                     something the help centre does not say.
    out_of_scope     nothing to do with the shop. Some are close to its words
                     on purpose -- "cancel my gym membership" -- because those
                     are the ones a similarity threshold gets wrong.
    action           it mentions cancelling an order. Some are requests; some
                     only sound like them.
- `kb_covers`        the help centre holds the information the message is
                     about. The target for the grounding decision, and for
                     threshold tuning.
- `needs_person`     the customer's problem is not solved by an answer.
- `expected_action`  what the intent recogniser should do: "propose",
                     "ask_order_number", or None.

`kb_covers` and `needs_person` are separate because they come apart, and that is
the finding this eval exists to measure: "my parcel is five days late" is in the
help centre -- it says to report it -- and still needs a person to open the
investigation. An answer there is a deflection.

`split` is FIXED and committed, never randomised, as in Project 1: a threshold is
chosen on `tune` and judged once on `holdout`. Every kind appears in both halves.
"""

from __future__ import annotations

from dataclasses import dataclass

KINDS = ("answerable", "needs_person", "out_of_scope", "action")
SPLITS = ("tune", "holdout")
ACTIONS = ("propose", "ask_order_number")


@dataclass(frozen=True)
class EvalTurn:
    id: str
    message: str
    kind: str
    split: str
    kb_covers: bool
    needs_person: bool
    expected_action: str | None = None
    expected_doc: str | None = None
    why: str = ""


def _answerable(id_, message, split, doc, why):
    return EvalTurn(id_, message, "answerable", split, True, False, None, doc, why)


def _needs_person(id_, message, split, kb_covers, why):
    return EvalTurn(id_, message, "needs_person", split, kb_covers, True, None, None, why)


def _out_of_scope(id_, message, split, why):
    return EvalTurn(id_, message, "out_of_scope", split, False, False, None, None, why)


def _action(id_, message, split, expected, why):
    return EvalTurn(id_, message, "action", split, True, False, expected, "cancelling-an-order", why)


DATASET: list[EvalTurn] = [
    # === answerable =======================================================
    _answerable("ans-return-window", "How long do I have to return something?", "tune",
                "returns-and-refunds", "30 days from delivery, in the return window section."),
    _answerable("ans-refund-timing", "When will my refund appear after you receive the return?", "holdout",
                "returns-and-refunds", "Inspection, then 3 to 5 working days."),
    _answerable("ans-free-delivery", "Is standard delivery free?", "tune",
                "delivery-and-tracking", "Free on orders over £40."),
    _answerable("ans-express-cost", "How much does express delivery cost?", "holdout",
                "delivery-and-tracking", "£5.95, next working day if ordered before 4pm."),
    _answerable("ans-sundays", "Do you deliver on Sundays?", "tune",
                "delivery-and-tracking", "No deliveries on Sundays or bank holidays."),
    _answerable("ans-cancel-after-dispatch", "Can I cancel an order after it has been dispatched?", "holdout",
                "cancelling-an-order", "A question about the rule, answered by it: no, refuse delivery or return it."),
    _answerable("ans-how-to-cancel", "How do I cancel an order?", "tune",
                "cancelling-an-order", "From the order page or by asking the assistant, before dispatch."),
    _answerable("ans-personalised-returns", "Can personalised items be returned?", "holdout",
                "returns-and-refunds", "Not unless they arrived faulty."),
    _answerable("ans-tracking-delay", "My tracking hasn't updated since I got the email. Is that normal?", "tune",
                "delivery-and-tracking", "Up to 12 hours for the first scan is normal. Said in different words."),
    _answerable("ans-missed-twice", "The courier came twice while I was out. What happens to my parcel now?", "holdout",
                "delivery-and-tracking", "Held at a depot for 7 days, then returned and refunded."),
    _answerable("ans-postage-change-of-mind", "If I send something back because I changed my mind, do I get the postage back?", "tune",
                "returns-and-refunds", "Original delivery charges are not refunded for a change of mind."),
    _answerable("ans-label-expiry", "How long is the returns label valid for?", "holdout",
                "returns-and-refunds", "Drop off within 14 days of the label being issued."),
    _answerable("ans-stop-before-shipping", "I bought something by mistake and it hasn't shipped yet. Can I still stop it?", "tune",
                "cancelling-an-order", "Yes, before dispatch. Never says 'cancel', so only meaning connects it."),
    _answerable("ans-released-authorisation", "How long until the money from a cancelled order is released?", "holdout",
                "cancelling-an-order", "3 to 5 working days, depending on the bank."),
    _answerable("ans-address-before-shipping", "Can I change the delivery address before my order ships?", "tune",
                "delivery-and-tracking", "Yes, while it is being prepared. A question, not a request to change it."),
    _answerable("ans-damage-deadline", "Is there a time limit for reporting a damaged item?", "holdout",
                "returns-and-refunds", "Within 6 months of delivery."),

    # === needs a person ===================================================
    _needs_person("person-late-parcel", "My parcel is five days late and still hasn't turned up.", "tune", True,
                  "The article says to report it so an investigation is opened. Only a person can open it: an answer alone deflects."),
    _needs_person("person-arrived-broken", "The desk lamp I ordered arrived with a cracked base.", "holdout", True,
                  "Faulty items are replaced or refunded, which someone has to arrange."),
    _needs_person("person-delivered-not-received", "Tracking says delivered but there is nothing here.", "tune", True,
                  "The nearest article section is about late parcels; the customer needs an investigation."),
    _needs_person("person-change-address-now", "Please change the delivery address on order 1042 to my work address.", "holdout", True,
                  "The article says addresses can change before dispatch, but nothing here can change one. A request, not a question."),
    _needs_person("person-charged-twice", "I was charged twice for the same order.", "tune", False,
                  "Billing errors are not in the help centre."),
    _needs_person("person-unrecognised-order", "Someone placed an order on my account that I don't recognise.", "holdout", False,
                  "A possible account compromise. Nothing in the help centre, and urgent."),
    _needs_person("person-asks-for-human", "I want to speak to a real person.", "tune", False,
                  "An explicit request for a person (FR-8.2)."),
    _needs_person("person-gift-cards", "Do you sell gift cards?", "holdout", False,
                  "About the shop, but not answered anywhere in the help centre. A person could answer it."),
    _needs_person("person-refund-overdue", "My refund still hasn't arrived after two weeks.", "tune", True,
                  "Longer than the stated timings, so someone has to find out why."),
    _needs_person("person-misspelt-personalisation", "The personalised mug I ordered has my name spelt wrong.", "holdout", True,
                  "Wrongly made personalised items are refunded, which someone has to arrange."),

    # === out of scope =====================================================
    _out_of_scope("oos-capital", "What is the capital of France?", "tune", "General knowledge."),
    _out_of_scope("oos-poem", "Write me a short poem about autumn.", "holdout", "Not a support question."),
    _out_of_scope("oos-weather", "What will the weather be like tomorrow?", "tune", "General knowledge."),
    _out_of_scope("oos-netflix", "How do I reset my Netflix password?", "holdout", "Another company's account."),
    _out_of_scope("oos-gym", "How do I cancel my gym membership?", "tune",
                  "Shares 'cancel' with the help centre and means nothing to it: the lexical trap."),
    _out_of_scope("oos-library-book", "Can I return a library book late without a fine?", "holdout",
                  "Shares 'return' with the help centre: the lexical trap again."),
    _out_of_scope("oos-pizza", "How long does delivery take for a pizza from the place down the road?", "tune",
                  "Shares 'delivery': the lexical trap."),
    _out_of_scope("oos-world-cup", "Who won the 2018 World Cup?", "holdout", "General knowledge."),

    # === mentions cancelling an order =====================================
    _action("act-cancel-numbered", "Please cancel my order 1043.", "tune", "propose",
            "A request naming its order."),
    _action("act-cancel-hash", "Cancel order #1047 please", "holdout", "propose",
            "The same request, written with a hash."),
    _action("act-cancel-unnumbered", "I want to cancel my order", "tune", "ask_order_number",
            "A request with no order: ask which one (FR-4.2), never guess."),
    _action("act-cancel-reference", "Can you cancel ACME-1043 for me?", "holdout", "propose",
            "A prefixed order reference."),
    _action("act-dont-cancel", "Don't cancel order 1043, I've changed my mind.", "tune", None,
            "Negation. Proposing here is the worst mistake the recogniser can make."),
    _action("act-what-if", "What happens if I cancel order 1043?", "holdout", None,
            "A question about cancelling, with a number in it. Not a request."),
    _action("act-cancel-unnumbered-polite", "I'd like to cancel my order", "holdout", "ask_order_number",
            "A request with no order, phrased politely."),
    _action("act-cancellation-noun", "cancellation of order 1042 please", "tune", "propose",
            "The noun form, lower case, no verb."),
    _action("act-no-need", "No need to cancel order 1041 anymore", "holdout", None,
            "Negation, phrased another way."),
    _action("act-could-you", "Could you cancel the order I placed yesterday?", "tune", "ask_order_number",
            "A request with no number, phrased with 'could'. The recogniser only knows 'can you'."),
]
