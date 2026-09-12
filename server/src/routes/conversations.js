import { Router } from 'express';
import { AppError } from '../errors/AppError.js';
import { scoped } from '../db/tenantScope.js';
import { Conversation, Message } from '../db/models/index.js';
import { streamTurn } from '../services/aiClient.js';
import { openSseStream, relayFrames, sseFrame } from '../services/sse.js';

export const conversationsRouter = Router();

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
 * Three things happen here that are worth reading closely.
 *
 * 1. THE CUSTOMER TURN IS PERSISTED BEFORE ANYTHING ELSE. If the AI service is
 *    down, the question the customer asked is still on the record and an agent
 *    can answer it. Losing the question because the advisory tier was
 *    unavailable would be the worst possible failure of FR-14.3.
 *
 * 2. CANCELLATION IS A CLIENT DISCONNECT (FR-1.3). There is no cancel frame;
 *    the server watches for the connection closing and aborts upstream. The
 *    partial turn is then persisted as `cancelled`, visibly, rather than
 *    silently completing or vanishing.
 *
 * 3. ERRORS AFTER THE HEADERS ARE SENT CANNOT BE A STATUS CODE. Once the
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
          onDropped: (frame) =>
            console.warn(
              JSON.stringify({
                level: 'warn',
                message: 'Dropped a frame the advisory tier is not permitted to send',
                event: frame.event,
                correlationId: req.correlationId,
              }),
            ),
        },
      );
    } catch (error) {
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
      correlationId: req.correlationId,
    });

    if (!cancelled) res.end();
  }),
);
