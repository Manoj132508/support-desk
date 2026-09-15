/**
 * What an assistant turn sends the AI service, and nothing more. NFR-4.
 *
 * The AI service is advisory and holds no customer record (ADR 0002). For a turn
 * it needs the customer's question and enough of the conversation for a
 * follow-up to make sense -- and its prompt keeps only the last
 * HISTORY_EXCHANGES exchanges (`prompt.build_history_messages`). Anything more
 * puts customer text into another process, and with a hosted model into another
 * company, for no use at all.
 *
 * Found in Phase 12: the route read the conversation's FIRST twenty messages,
 * oldest first, and dropped the last of those on the assumption that it was
 * the question just asked. In any conversation longer than twenty messages the
 * service received the opening turns instead of the latest ones, lost one of
 * them, and was sent over three times the history its prompt could use.
 */

/** Must equal `limit` in ai-service/app/pipeline/prompt.py; a test reads it. */
export const HISTORY_EXCHANGES = 3;
export const HISTORY_MESSAGES = HISTORY_EXCHANGES * 2;

/** Read a little more than is sent, because some rows are skipped below. */
export const HISTORY_READ_LIMIT = HISTORY_MESSAGES * 2 + 1;

/** The only roles the prompt uses. Anything else -- an agent's or a system
 *  message -- stays on this side of the boundary. */
const ROLE_FOR_PROMPT = { customer: 'user', assistant: 'assistant' };

/**
 * @param newestFirst  the conversation's recent messages, newest first
 * @param exclude      the id of the question being asked, which travels as
 *                     `question` and must not appear twice
 */
export function turnHistory(newestFirst, { exclude = null } = {}) {
  return newestFirst
    .filter((message) => exclude === null || String(message._id) !== String(exclude))
    .filter(
      (message) =>
        Object.hasOwn(ROLE_FOR_PROMPT, message.role) && typeof message.content === 'string' && message.content !== '',
    )
    .slice(0, HISTORY_MESSAGES)
    .reverse()
    .map((message) => ({ role: ROLE_FOR_PROMPT[message.role], content: message.content }));
}
