"""Recognising a request to TAKE an action, as opposed to a question ABOUT one.

WHY THIS EXISTS, STATED PLAINLY
-------------------------------
The architecture has the advisory tier propose actions, and the natural
proposer is the model, through structured tool calls. Live inference is blocked
on this machine by a GPU fault (Phase 1 section 8). So while that is true,
proposals come from this deterministic recogniser -- and the documentation says
so, rather than implying a model decided anything.

That substitution does not weaken INV-A at all, which is the point of the
architecture. Express treats whatever arrives from this service as an untrusted
request: a model, this module, or an attacker who had compromised this process
are all held to the same boundary, the same policy engine and the same customer
confirmation. Nothing here authorises anything, and nothing here could.

WHAT IT IS TUNED FOR: BEING CONSERVATIVE
----------------------------------------
There are two ways to be wrong, and they are not equally bad.

A missed request -- the customer asked to cancel and this did not notice -- gets
an ordinary grounded answer, which cites the cancellation article and offers a
person. Mildly unhelpful; entirely safe.

A false proposal -- this "noticed" a request that was not one -- puts a
confirmation dialog in front of someone who only asked how cancellation works.
Still safe, because nothing happens without confirmation. But it is alarming,
and it teaches customers that the assistant acts on things they did not say.

So every rule below leans toward NOT proposing:

- negation always wins ("don't cancel order 1043" never proposes);
- a question ABOUT cancelling ("how do I...", "what happens if I cancel order
  1043?") never proposes, even with a number in it;
- a request with no concrete order number does not guess which order. It asks.
  That is FR-4.2 exactly: if the target cannot be resolved, ask the customer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

ACTION_TYPE = "order.cancel"

# Must stay within the server's bound on evidence entries
# (MAX_EVIDENCE in server/src/policy/proposal.js). A proposal over it would be
# rejected as malformed -- correctly, but for a reason this service can avoid.
MAX_EVIDENCE = 20

# Static text. These are not model output, and deliberately phrased so that
# neither says or implies that anything has happened yet -- the same rule the
# system prompt holds the model to.
ASK_FOR_ORDER_NUMBER = (
    "I can help with that. Which order would you like to cancel? "
    "Please give me the order number."
)
CHECKING_ORDER = "I can help with that. Let me check whether order {order_number} can be cancelled."


@dataclass(frozen=True)
class ActionRequest:
    action_type: str
    order_number: str | None

    @property
    def needs_order_number(self) -> bool:
        return self.order_number is None


_CANCEL = re.compile(r"\bcancel(?:l?ed|l?ing|lation)?\b", re.IGNORECASE)

# "don't cancel", "do not cancel", "never cancel", "no need to cancel",
# "not going to cancel" -- anywhere shortly before the verb.
_NEGATION = re.compile(
    r"\b(?:don't|dont|do\s+not|never|no\s+need\s+to|not\s+(?:want|going)\s+to)\b[^.?!]{0,30}\bcancel",
    re.IGNORECASE,
)

# A question about the process, not a request to act.
_QUESTION_ABOUT = re.compile(r"^\s*(?:how|what|when|why|where|which|who)\b", re.IGNORECASE)

# A concrete order reference must contain a digit, so "cancel my order please"
# can never yield "please" as an order number.
_TOKEN = r"([A-Za-z]{0,6}-?\d[A-Za-z0-9-]{0,30})"
_AFTER_ORDER_WORD = re.compile(
    r"\border\b(?:\s+(?:number|no\.?|num|ref(?:erence)?))?\s*[:#]?\s*" + _TOKEN,
    re.IGNORECASE,
)
_AFTER_HASH = re.compile(r"#\s*" + _TOKEN)
_PREFIXED_REFERENCE = re.compile(r"\b([A-Za-z]{2,6}-\d{2,}[A-Za-z0-9-]*)\b")

# A clear request that names no order. Recognised so the assistant can ASK which
# order, rather than falling back to a generic answer.
_REQUEST_WITHOUT_NUMBER = re.compile(
    r"^\s*(?:please\s+)?(?:"
    r"cancel\s+(?:my|the|this)\s+order"
    r"|i\s+(?:want|would\s+like|need)\s+to\s+cancel\s+(?:my|the|this)\s+order"
    r"|i'd\s+like\s+to\s+cancel\s+(?:my|the|this)\s+order"
    r"|can\s+you\s+(?:please\s+)?cancel\s+(?:my|the|this)\s+order"
    r")",
    re.IGNORECASE,
)


def _normalise(text: str) -> str:
    # Curly apostrophes arrive from phones and word processors; without this,
    # "I’d like to cancel my order" would not match "i'd".
    return text.replace("’", "'").replace("‘", "'")


def _extract_order_number(text: str) -> str | None:
    for pattern in (_AFTER_ORDER_WORD, _AFTER_HASH, _PREFIXED_REFERENCE):
        match = pattern.search(text)
        if match:
            # Kept exactly as typed. The server resolves it against the
            # customer's own orders and carries the database's canonical number
            # forward -- this module never decides what the "real" number is.
            return match.group(1)
    return None


def detect_action_request(text: str) -> ActionRequest | None:
    """Return the action the customer is asking for, or None.

    None is the default and the safe answer. See the module docstring for why
    each check leans toward it.
    """
    if not text:
        return None

    normalised = _normalise(text)

    if not _CANCEL.search(normalised):
        return None
    if _NEGATION.search(normalised):
        return None
    if _QUESTION_ABOUT.search(normalised):
        return None

    order_number = _extract_order_number(normalised)
    if order_number is not None:
        return ActionRequest(ACTION_TYPE, order_number)

    if _REQUEST_WITHOUT_NUMBER.search(normalised):
        return ActionRequest(ACTION_TYPE, None)

    return None


def build_proposal(request: ActionRequest, evidence_refs: list[str] | None = None) -> dict:
    """The raw proposal sent upstream to Express.

    Exactly the fields the server's boundary accepts, and nothing else -- no
    confirmation text, no claim of authorisation, no customer or tenant. The
    server rejects any extra field as malformed (and records an attempt to assert
    authorisation under its own code), so adding one here would not grant
    anything; it would only get every proposal from this service refused.
    """
    if request.order_number is None:
        raise ValueError(
            "A proposal needs a concrete order number. Ask the customer instead (FR-4.2)."
        )

    refs = [ref for ref in (evidence_refs or []) if isinstance(ref, str) and ref.strip()]
    return {
        "actionType": request.action_type,
        "target": {"kind": "order", "orderNumber": request.order_number},
        "evidence": [{"kind": "kb_chunk", "ref": ref} for ref in refs[:MAX_EVIDENCE]],
    }
