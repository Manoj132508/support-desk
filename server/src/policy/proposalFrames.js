/**
 * What the CUSTOMER'S stream is told about a proposal.
 *
 * The AI service never sends the browser a proposal. It sends Express a raw
 * `proposal_request`, which Express intercepts and does not forward (see
 * services/sse.js). Express then runs it through the boundary, the policy
 * engine and the audit (actionService.propose), and only the RESULT of that
 * becomes a frame -- built here, from an allowlist of fields.
 *
 * Two separate event names are the point. If the advisory tier's raw event and
 * the browser's event shared a name, a relay that forwarded "proposal" frames
 * would be one mistaken line away from letting the model open its own
 * confirmation dialog. With different names, the raw proposal cannot reach the
 * browser even by accident: nothing forwards `proposal_request`, and nothing
 * upstream is allowed to send `proposal`.
 *
 * What is never included, because this stream serves customers (ADR 0007):
 * rule keys, versions, matched conditions, problem codes, idempotency keys,
 * internal reasons. The rule's own `customerMessage` is the only policy text a
 * customer sees.
 */

export const DOWNSTREAM_PROPOSAL_EVENTS = Object.freeze(['proposal', 'policy']);

export function framesForProposalResult(result) {
  switch (result?.kind) {
    case 'confirm':
      // Everything ConfirmationDialog needs, and nothing else. The order number
      // is the database's canonical one, taken from the recorded proposal, and
      // the text was rendered from the order record when the proposal was
      // written (FR-6.1).
      return [
        {
          event: 'proposal',
          data: {
            id: String(result.proposalId),
            actionType: result.actionType,
            target: { kind: 'order', orderNumber: result.target.orderNumber },
            confirmText: result.confirmText,
          },
        },
      ];

    case 'refused':
    case 'escalated':
      // Both render in the client's POLICY language, never as an error
      // (Phase 4 §5). `kind` stays within the client's four-kind taxonomy;
      // `outcome` carries the precise distinction for the UI to use.
      return [
        {
          event: 'policy',
          data: {
            kind: 'refused',
            outcome: result.kind === 'refused' ? 'refused_at_proposal' : 'escalated_at_proposal',
            proposalId: String(result.proposalId),
            customerMessage: result.decision?.customerMessage ?? null,
          },
        },
      ];

    case 'malformed':
      // No customer message: nothing about WHY a proposal was malformed is
      // customer information, and the codes would describe the boundary. The
      // client falls back to its generic text and offers a person.
      return [
        {
          event: 'policy',
          data: {
            kind: 'malformed',
            outcome: null,
            proposalId: String(result.proposalId),
            customerMessage: null,
          },
        },
      ];

    default:
      // A result this code does not recognise is a programming error. Telling
      // the customer anything specific would be inventing a decision nobody
      // made, so it surfaces as a fault instead.
      throw new Error(`Unknown proposal result kind: ${result?.kind}`);
  }
}
