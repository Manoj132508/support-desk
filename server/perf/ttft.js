import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseFrames } from '../src/services/aiClient.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../src/auth/cookies.js';
import { DEMO_PASSWORD } from '../scripts/seedData.js';
import { formatDuration, summarise } from './stats.js';

/**
 * NFR-1: time to first streamed token, p95 under 2.5 s on the dev machine.
 *
 *   npm run perf:ttft -- --base http://localhost:5179 --repeats 3 --out results.json
 *
 * Drives the RUNNING stack the way a customer does: signs in as seeded
 * customers, opens a conversation, sends a message, and reads the stream. The
 * clock starts just before the request is sent and stops when a frame arrives,
 * so every hop is included: the Vite proxy, authentication, the database, the
 * AI service, and the model when one is called.
 *
 * Each turn is sent in a NEW conversation, and two of them are followed by a
 * second question in the same conversation, reported separately as
 * "(follow-up)". A follow-up carries history, and history once pushed the
 * sources to a different place in every conversation's prompt, which made the
 * model read them from scratch (ADR 0011). A harness of first turns only would
 * never have shown it.
 *
 * NFR-1 names one number, but a turn's first token means different things by
 * kind: on a proposal, a handoff or a request for an order number no model is
 * called and the first token is static text, while an answer waits for the
 * model to read its prompt. Pooling them would let fast static turns hide slow
 * answers, so results are reported per kind as well as overall.
 *
 * DEVELOPMENT ONLY. It signs in with the seed's published password, which exists
 * nowhere else, and it refuses any host but this machine.
 */

export const TURNS = Object.freeze([
  {
    expected: 'answered',
    message: 'How long do I have to return something?',
    followUp: 'If I send something back because I changed my mind, do I get the postage back?',
  },
  { expected: 'offered_person', message: 'What is the capital of France?' },
  {
    expected: 'answered',
    message: 'Can I cancel an order after it has been dispatched?',
    followUp: 'How long until the money from a cancelled order is released?',
  },
  { expected: 'propose', message: 'Please cancel my order 1043.', customer: 'ana@acme.test' },
  { expected: 'answered', message: 'When will my refund appear after you receive the return?' },
  { expected: 'ask_order_number', message: 'I want to cancel my order' },
  { expected: 'answered', message: 'How much does express delivery cost?' },
  { expected: 'offered_person', message: 'I want to speak to a real person.' },
  { expected: 'answered', message: 'The courier came twice while I was out. What happens to my parcel now?' },
]);

export const NFR1_BUDGET_MS = 2_500;

// The message limiter allows 20 a minute per customer. One every 3.2 s keeps
// each customer under it with room to spare.
const MIN_GAP_PER_CUSTOMER_MS = 3_200;

export function assertLocalBase(base) {
  const { hostname } = new URL(base);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error(`Refusing to run against ${hostname}: the seed accounts exist only in development.`);
  }
}

/** A minimal cookie jar: name=value pairs from Set-Cookie headers. */
export function makeCookieJar() {
  const cookies = new Map();
  return {
    store(setCookieHeaders) {
      for (const header of setCookieHeaders ?? []) {
        const [pair] = header.split(';');
        const index = pair.indexOf('=');
        if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    get: (name) => cookies.get(name),
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

/** What the customer experienced, from the stream's final frame. */
export function observedKind(done) {
  if (!done) return null;
  if (done.action) return done.action;
  return done.grounded ? 'answered' : 'offered_person';
}

/** Per-kind and overall summaries of the samples, with the NFR-1 verdict. */
export function summariseTurns(samples, { budgetMs = NFR1_BUDGET_MS } = {}) {
  const usable = samples.filter((sample) => sample.firstTokenMs !== null);
  const groups = new Map();
  for (const sample of usable) {
    if (!groups.has(sample.kind)) groups.set(sample.kind, []);
    groups.get(sample.kind).push(sample.firstTokenMs);
  }
  const byKind = Object.fromEntries(
    [...groups].map(([kind, values]) => {
      const summary = summarise(values);
      return [kind, { ...summary, meetsBudget: summary.p95 < budgetMs }];
    }),
  );
  const overall = usable.length ? summarise(usable.map((sample) => sample.firstTokenMs)) : null;
  return {
    budgetMs,
    byKind,
    overall: overall && { ...overall, meetsBudget: overall.p95 < budgetMs },
    failed: samples.length - usable.length,
  };
}

async function signIn(base, email, tenantSlug) {
  const jar = makeCookieJar();
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_PASSWORD, tenantSlug }),
  });
  if (response.status !== 200) throw new Error(`Sign-in as ${email} returned ${response.status}. Has the database been seeded?`);
  jar.store(response.headers.getSetCookie());
  return jar;
}

function authedHeaders(jar) {
  return { Cookie: jar.header(), [CSRF_HEADER]: jar.get(CSRF_COOKIE), 'Content-Type': 'application/json' };
}

async function timeTurn(base, jar, message, conversationId = null) {
  let id = conversationId;
  if (!id) {
    const created = await fetch(`${base}/api/conversations`, { method: 'POST', headers: authedHeaders(jar), body: '{}' });
    if (created.status !== 201) throw new Error(`Creating a conversation returned ${created.status}`);
    const { conversation } = await created.json();
    id = conversation.id ?? conversation._id;
  }

  const started = performance.now();
  const response = await fetch(`${base}/api/conversations/${id}/messages`, {
    method: 'POST',
    headers: { ...authedHeaders(jar), Accept: 'text/event-stream' },
    body: JSON.stringify({ content: message }),
  });
  const sample = {
    conversationId: id,
    status: response.status,
    correlationId: response.headers.get('x-correlation-id'),
    headersMs: performance.now() - started,
    firstFrameMs: null,
    firstTokenMs: null,
    finishedMs: null,
    done: null,
    error: null,
  };
  if (response.status !== 200 || !response.body) return sample;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = parseFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const at = performance.now() - started;
      sample.firstFrameMs ??= at;
      if (frame.event === 'token') sample.firstTokenMs ??= at;
      if (frame.event === 'done') sample.done = frame.data;
      if (frame.event === 'error') sample.error = frame.data?.kind ?? 'error';
    }
  }
  sample.finishedMs = performance.now() - started;
  return sample;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runTtft({ base, repeats = 1, customers = ['ana@acme.test', 'ben@acme.test'], tenantSlug = 'acme', log = console.log }) {
  assertLocalBase(base);
  const jars = new Map();
  for (const email of customers) jars.set(email, await signIn(base, email, tenantSlug));
  const lastSent = new Map();

  const samples = [];
  let rotation = 0;
  const send = async ({ email, message, expected, round, conversationId = null, followUp = false }) => {
    const wait = MIN_GAP_PER_CUSTOMER_MS - (performance.now() - (lastSent.get(email) ?? -Infinity));
    if (wait > 0) await sleep(wait);
    lastSent.set(email, performance.now());

    const timed = await timeTurn(base, jars.get(email), message, conversationId);
    const observed = observedKind(timed.done);
    const sample = {
      index: samples.length,
      round,
      followUp,
      expected,
      // A follow-up is its own row: it is the turn that carries history.
      kind: observed && followUp ? `${observed} (follow-up)` : observed,
      ...timed,
    };
    samples.push(sample);
    log(
      `  ${String(sample.index + 1).padStart(3)}  ${(sample.kind ?? `status ${sample.status}`).padEnd(28)}` +
        `first token ${sample.firstTokenMs === null ? '   --  ' : formatDuration(sample.firstTokenMs).padStart(9)}` +
        `  done ${sample.finishedMs === null ? '--' : formatDuration(sample.finishedMs).padStart(9)}` +
        `${observed && observed !== expected ? `  (expected ${expected})` : ''}${sample.error ? `  error: ${sample.error}` : ''}`,
    );
    return sample;
  };

  for (let round = 0; round < repeats; round += 1) {
    for (const turn of TURNS) {
      const email = turn.customer ?? customers[rotation++ % customers.length];
      const first = await send({ email, message: turn.message, expected: turn.expected, round });
      if (turn.followUp && first.status === 200) {
        await send({ email, message: turn.followUp, expected: 'answered', round, conversationId: first.conversationId, followUp: true });
      }
    }
  }
  return { base, repeats, at: new Date().toISOString(), samples, summary: summariseTurns(samples) };
}

function printSummary({ summary }) {
  const line = '='.repeat(84);
  console.log(`\n${line}\n  TIME TO FIRST TOKEN -- NFR-1 (p95 budget ${formatDuration(summary.budgetMs)})\n${line}`);
  console.log(`  ${'kind'.padEnd(28)}${'n'.padStart(4)}${'p50'.padStart(11)}${'p95'.padStart(11)}${'max'.padStart(11)}   verdict`);
  const rows = [...Object.entries(summary.byKind), ...(summary.overall ? [['ALL TURNS', summary.overall]] : [])];
  for (const [kind, row] of rows) {
    console.log(
      `  ${kind.padEnd(28)}${String(row.n).padStart(4)}${formatDuration(row.p50).padStart(11)}` +
        `${formatDuration(row.p95).padStart(11)}${formatDuration(row.max).padStart(11)}   ${row.meetsBudget ? 'meets' : 'MISSES'}`,
    );
  }
  if (summary.failed) console.log(`\n  ${summary.failed} turn(s) produced no token and are excluded above.`);
  console.log(`${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > -1 ? process.argv[index + 1] : fallback;
  };
  const result = await runTtft({ base: arg('base', 'http://localhost:5179'), repeats: Number(arg('repeats', 1)) });
  printSummary(result);
  const out = arg('out');
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
