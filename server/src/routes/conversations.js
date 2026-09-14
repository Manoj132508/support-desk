import { Router } from 'express';
import { AppError } from '../errors/AppError.js';
import { scoped } from '../db/tenantScope.js';
import { Conversation, Message } from '../db/models/index.js';
import { streamTurn } from '../services/aiClient.js';
import { openSseStream, relayFrames, sseFrame } from '../services/sse.js';
import { makeActionService } from '../policy/actionService.js';
import { makeMongoActionRepo } from '../policy/mongoActionRepo.js';
import { framesForProposalResult } from '../policy/proposalFrames.js';

export const conversationsRouter = Router();

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function jsonLog(event, fields) {
  // Structured logs, which rotate -- where the readable messages go that must
  // never enter an immutable audit row.
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

/** Proposals raised in conversation go through the same action service as
 *  confirmation does: one boundary, one engine, one audit. */
const actions = makeActionService({ repo: makeMongoActionRepo(), log: jsonLog });

/** A customer acts on their own conversations; staff read them in the console.
 *  `customerId` comes from the session (Phase 8), never from the request. */
function subjectCustomerId(req) {
  if (req.user.role === 'customer') {
    if (!req.user.customerId) throw AppError.fault('Customer account is not linked to a profile');
    return req.user.customerId;
  }
  return null;
}

// Every route below is already behind `authenticate` and `requireCsrfToken`,
// by position in routes/index.js. Nothing here re-checks that.

/** POST /api/conversations */
conversationsRouter.post(
  '/',
  handle(async (req, res) => {
    const customerId = subjectCustomerId(req);
    if (!customerId) throw AppError.malformed('Only a customer can start a conversation');

    const [conversation] = await scoped(Conversation, req).create({ customerId });
    res.status(201).json({ conversation });
  }),
);

/** GET /api/conversations/:id */
conversationsRouter.get(
  '/:id',
  handle(async (req, res) => {
    // Tenancy is in the query, and a foreign conversation is indistinguishable
    // from a missing one (ADR 0005).
    const conversation = await scoped(Conversation, req).findByIdOrNotFound(req.params.id);

    // A customer may only read their own. Staff read any within the tenant --
    // that is the agent console's whole purpose.
    if (req.user.role === 'customer' && String(conversation.customerId) !== req.user.customerId) {
      throw AppError.notFound();
    }

    const messages = await scoped(Message, req)
      .find({ conversationId: conversation._id })
      .sort({ createdAt: 1 });

    res.json({ conversation, messages });
  }),
);

/**
 * POST /api/conversations/:id/messages — the streaming turn.
 *
 * Four things happen here that are worth reading closely.
 *
 * 1. THE CUSTOMER TURN IS PERSISTED BEFORE ANYTHING ELSE. If the AI service is
 *    down, the question the customer asked is still on the record and an agent
 *    can answer it. Losing the question because the advisory tier was
 *    unavailable would be the worst possible failure of FR-14.3.
 *
 * 2. A PROPOSAL IS INTERCEPTED, NEVER RELAYED. The AI service sends a raw
 *    `proposal_request`; the relay hands it to the action service, which
 *    validates, resolves, records and evaluates it, and the customer receives
 *    only the result -- a `proposal` frame for confirmation or a `policy`
 *    notice. Only a customer's own turn may raise a proposal (ADR 0009: the
 *    customer confirms). On a staff turn the request is simply dropped.
 *
 * 3. CANCELLATION IS A CLIENT DISCONNECT (FR-1.3). There is no cancel frame;
 *    the server watches for the connection closing and aborts upstream. The
 *    partial turn is then persisted as `cancelled`, visibly, rather than
 *    silently completing or vanishing.
 *
 * 4. ERRORS AFTER THE HEADERS ARE SENT CANNOT BE A STATUS CODE. Once the
 *    stream is open the response is committed, so a failure is delivered as an
 *    `error` FRAME -- and that frame carries only `fault`, never a refusal,
 *    because a refusal belongs in the client's policy language (Phase 4 §5).
 */
conversationsRouter.post(
  '/:id/messages',
  handle(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) throw AppError.malformed('A message needs content');
    if (content.length > 4000) throw AppError.malformed('Message is too long');

    const conversation = await scoped(Conversation, req).findByIdOrNotFound(req.params.id);
    if (req.user.role === 'customer' && String(conversation.customerId) !== req.user.customerId) {
      throw AppError.notFound();
    }

    await scoped(Message, req).create({
      conversationId: conversation._id,
      role: 'customer',
      content,
      correlationId: req.correlationId,
    });

    const history = (
      await scoped(Message, req)
        .find({ conversationId: conversation._id })
        .sort({ createdAt: 1 })
        .limit(20)
    ).map((message) => ({
      role: message.role === 'customer' ? 'user' : 'assistant',
      content: message.content,
    }));

    const controller = new AbortController();
    let cancelled = false;
    req.on('close', () => {
      if (!res.writableEnded) {
        cancelled = true;
        controller.abort();
      }
    });

    // Only a customer's own turn may raise a proposal. Staff turns get no
    // handler, so a `proposal_request` on one is dropped like any frame
    // Express does not accept.
    let proposalId = null;
    const onProposalRequest =
      req.user.role === 'customer' && req.user.customerId
        ? async (raw) => {
            const result = await actions.propose({
              ctx: req,
              customerId: req.user.customerId,
              conversationId: conversation._id,
              raw,
              correlationId: req.correlationId,
            });
            proposalId = result.proposalId;
            return framesForProposalResult(result);
          }
        : undefined;

    openSseStream(res);

    let seen;
    try {
      seen = await relayFrames(
        streamTurn({
          question: content,
          history: history.slice(0, -1),
          correlationId: req.correlationId,
          signal: controller.signal,
        }),
        res,
        {
          onProposalRequest,
          onDropped: (frame) =>
            console.warn(
              JSON.stringify({
                level: 'warn',
                message: 'Dropped a frame Express does not accept on this turn',
                event: frame.event,
                correlationId: req.correlationId,
              }),
            ),
        },
      );
    } catch (error) {
      // Stop the advisory tier generating tokens nobody will read. Without this
      // a failure mid-turn -- a database error while recording a proposal, say
      // -- would leave the model running to completion behind a closed stream.
      controller.abort();

      // Headers are already sent, so this cannot be a status code.
      res.write(sseFrame('error', { kind: 'fault', message: 'The assistant is unavailable' }));
      res.end();
      console.error(
        JSON.stringify({
          level: 'error',
          message: error.message,
          correlationId: req.correlationId,
        }),
      );
      return;
    }

    await scoped(Message, req).create({
      conversationId: conversation._id,
      role: 'assistant',
      content: seen.tokens.join(''),
      state: cancelled ? 'cancelled' : 'complete',
      evidence: seen.evidence.map((item) => ({ kind: item.kind, ref: item.ref })),
      proposalId,
      correlationId: req.correlationId,
    });

    if (!cancelled) res.end();
  }),
);
