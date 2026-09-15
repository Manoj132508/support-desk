import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HISTORY_EXCHANGES, HISTORY_MESSAGES, turnHistory } from '../src/services/turnPayload.js';
import { config } from '../src/config/env.js';
import { streamTurn } from '../src/services/aiClient.js';

/**
 * NFR-4: what crosses to the AI service on a turn, and what does not.
 */

/** A conversation of `count` messages, alternating customer and assistant,
 *  returned NEWEST FIRST as the route reads it. */
function conversation(count) {
  const messages = [];
  for (let i = 1; i <= count; i += 1) {
    messages.push({
      _id: `m${i}`,
      role: i % 2 === 1 ? 'customer' : 'assistant',
      content: `message ${i}`,
      createdAt: new Date(2026, 8, 15, 9, 0, i),
      evidence: [{ kind: 'kb_chunk', ref: 'doc:1' }],
      correlationId: 'corr',
    });
  }
  return messages.reverse();
}

test('NFR-4: a long conversation sends its LATEST exchanges, in order, and never the question twice', () => {
  // 31 messages: the 31st is the customer's question, just saved.
  const history = turnHistory(conversation(31), { exclude: 'm31' });
  assert.deepEqual(
    history.map((message) => message.content),
    ['message 25', 'message 26', 'message 27', 'message 28', 'message 29', 'message 30'],
  );
  assert.equal(history[0].role, 'user');
});

test('the question is left out by its id, even if another message landed after it', () => {
  const recent = conversation(4);
  // m4 (assistant) is newest, but the question being asked is m3.
  const history = turnHistory(recent, { exclude: 'm3' });
  assert.deepEqual(history.map((message) => message.content), ['message 1', 'message 2', 'message 4']);
});

test('only the two roles the prompt uses cross, as role and content — no ids, times, evidence or correlation', () => {
  const recent = [
    { _id: 'a', role: 'agent', content: 'An agent note', createdAt: new Date() },
    { _id: 'b', role: 'system', content: 'System text', createdAt: new Date() },
    { _id: 'c', role: 'assistant', content: '', createdAt: new Date() },
    ...conversation(2),
  ];
  const history = turnHistory(recent);
  assert.deepEqual(history, [
    { role: 'user', content: 'message 1' },
    { role: 'assistant', content: 'message 2' },
  ]);
});

test('never more than the prompt’s window, however much is read', () => {
  assert.equal(turnHistory(conversation(50)).length, HISTORY_MESSAGES);
});

test('the window matches the AI service’s prompt, so the two cannot drift apart', () => {
  const source = readFileSync(new URL('../../ai-service/app/pipeline/prompt.py', import.meta.url), 'utf8');
  const match = source.match(/def build_history_messages\(history: list\[dict\], limit: int = (\d+)\)/);
  assert.ok(match, 'build_history_messages signature not found in prompt.py');
  assert.equal(Number(match[1]), HISTORY_EXCHANGES);
});

test('NFR-4: the request to the AI service carries the question, the history and a correlation id — nothing about the customer', async (t) => {
  config.aiServiceUrl = 'http://ai.test';
  config.aiServiceToken = 'service-token';
  let sent = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url, init };
    return { ok: true, body: new ReadableStream({ start: (controller) => controller.close() }) };
  });

  for await (const frame of streamTurn({ question: 'Where is my order?', history: [], correlationId: 'corr-1' })) {
    assert.fail(`unexpected frame ${frame.event}`);
  }

  assert.equal(sent.url, 'http://ai.test/turn');
  assert.deepEqual(Object.keys(JSON.parse(sent.init.body)).sort(), ['correlation_id', 'history', 'question']);
  assert.equal(sent.init.headers['X-Service-Token'], 'service-token');
});
