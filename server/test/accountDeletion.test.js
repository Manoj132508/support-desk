import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountDeletion } from '../src/account/accountDeletion.js';
import { makeMongoAccountRepo } from '../src/account/mongoAccountRepo.js';

/**
 * FR-13.4: deleting an account de-identifies the customer and leaves the audit
 * alone. The service and the repository are tested separately; neither needs a
 * database. What needs a replica set -- that the writes really commit together
 * -- is listed as unverified in the Phase 12 doc.
 */

const CTX = { tenantId: 't1' };
const NOW = new Date('2026-09-16T10:00:00Z');
const CUSTOMER = { id: 'user-1', role: 'customer', tenantId: 't1', customerId: 'cust-1' };
const REMOVED = { messages: 12, conversations: 2, ticketsScrubbed: 1 };

function fakeRepo({ account = { _id: 'user-1', passwordHash: 'the-hash' } } = {}) {
  const calls = [];
  return {
    calls,
    async findUserWithHash(ctx, userId) {
      calls.push(['findUserWithHash', userId]);
      return account;
    },
    async deidentifyCustomer(ctx, args) {
      calls.push(['deidentifyCustomer', args]);
      return REMOVED;
    },
  };
}

const PASSWORD = 'correct horse battery';

function setup({ account, passwordMatches = true } = {}) {
  const repo = fakeRepo({ account });
  const logged = [];
  const compared = [];
  const service = makeAccountDeletion({
    repo,
    clock: () => NOW,
    log: (event, fields) => logged.push({ event, fields }),
    // As strict as bcrypt: only the right password against the right hash.
    // The first version of this fake ignored the password, and so passed a
    // test that the service was right to fail.
    verifyPassword: async (password, hash) => {
      compared.push({ password, hash });
      return passwordMatches && password === PASSWORD && hash === 'the-hash';
    },
  });
  return { service, repo, logged, compared };
}

/* ── The service ──────────────────────────────────────────────────────── */

test('FR-13.4: the right password de-identifies the customer, in one repository call, at the injected time', async () => {
  const { service, repo, compared } = setup();
  const result = await service.deleteOwnAccount({ ctx: CTX, user: CUSTOMER, password: 'correct horse battery' });

  assert.deepEqual(result, REMOVED);
  assert.deepEqual(compared, [{ password: 'correct horse battery', hash: 'the-hash' }]);
  assert.deepEqual(repo.calls.at(-1), ['deidentifyCustomer', { userId: 'user-1', customerId: 'cust-1', now: NOW }]);
});

test('the password is asked for again: a session alone cannot erase someone', async () => {
  const { service, repo } = setup({ passwordMatches: false });
  await assert.rejects(
    service.deleteOwnAccount({ ctx: CTX, user: CUSTOMER, password: 'guess' }),
    (error) => error.status === 403 && error.expected === true,
  );
  assert.equal(repo.calls.some(([name]) => name === 'deidentifyCustomer'), false);
});

test('a password that is not a string is a wrong password, never a query', async () => {
  const { service, compared } = setup();
  await assert.rejects(service.deleteOwnAccount({ ctx: CTX, user: CUSTOMER, password: { $ne: '' } }), (error) => error.status === 403);
  assert.equal(compared[0].password, '');
});

test('staff accounts are not deleted this way, and the repository is never asked', async () => {
  for (const user of [{ ...CUSTOMER, role: 'agent' }, { ...CUSTOMER, customerId: null }]) {
    const { service, repo } = setup();
    await assert.rejects(service.deleteOwnAccount({ ctx: CTX, user, password: 'x' }), (error) => error.status === 404);
    assert.equal(repo.calls.length, 0);
  }
});

test('an account that no longer exists is not found', async () => {
  const { service } = setup({ account: null });
  await assert.rejects(service.deleteOwnAccount({ ctx: CTX, user: CUSTOMER, password: 'x' }), (error) => error.status === 404);
});

test('NFR-4: the deletion is logged with ids and counts, and nothing that identifies a person', async () => {
  const { service, logged } = setup();
  await service.deleteOwnAccount({ ctx: { ...CTX, user: CUSTOMER }, user: { ...CUSTOMER, email: 'ana@acme.test', name: 'Ana' }, password: PASSWORD });

  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'account_deleted');
  assert.deepEqual(Object.keys(logged[0].fields).sort(), ['conversations', 'customerId', 'messages', 'tenantId', 'ticketsScrubbed']);
  assert.equal(JSON.stringify(logged[0].fields).includes('ana'), false);
});

/* ── The repository ───────────────────────────────────────────────────── */

function fakeModels({ conversations = [{ _id: 'conv-1' }, { _id: 'conv-2' }], usersDeleted = 1 } = {}) {
  const log = [];
  const write = (op, result) => async (filter, updateOrOptions, maybeOptions) => {
    const [update, options] = maybeOptions === undefined ? [undefined, updateOrOptions] : [updateOrOptions, maybeOptions];
    log.push({ op, filter, update, options });
    return result;
  };
  const refuse = (name) =>
    new Proxy({}, { get: (target, property) => () => { throw new Error(`${name}.${String(property)} must never be called`); } });

  return {
    log,
    User: {
      findOne: (filter) => {
        log.push({ op: 'User.findOne', filter });
        const chain = {
          select: (fields) => {
            log.push({ op: 'User.findOne.select', fields });
            return chain;
          },
          lean: async () => ({ _id: 'user-1', passwordHash: 'the-hash' }),
        };
        return chain;
      },
      deleteOne: write('User.deleteOne', { deletedCount: usersDeleted }),
    },
    Customer: { updateOne: write('Customer.updateOne', { modifiedCount: 1 }) },
    Conversation: {
      find: (filter) => {
        log.push({ op: 'Conversation.find', filter });
        const chain = {
          select: () => chain,
          session: (session) => {
            log.push({ op: 'Conversation.find.session', session });
            return chain;
          },
          lean: async () => conversations,
        };
        return chain;
      },
      deleteMany: write('Conversation.deleteMany', { deletedCount: conversations.length }),
    },
    Message: { deleteMany: write('Message.deleteMany', { deletedCount: 12 }) },
    Ticket: { updateMany: write('Ticket.updateMany', { modifiedCount: 1 }) },
    // ADR 0006: if deletion ever reached for the audit spine, these would throw.
    ActionProposal: refuse('ActionProposal'),
    ActionOutcome: refuse('ActionOutcome'),
    PolicyDecision: refuse('PolicyDecision'),
    TicketEvent: refuse('TicketEvent'),
  };
}

function repoWith(options) {
  const models = fakeModels(options);
  const sessions = [];
  const repo = makeMongoAccountRepo({
    models,
    startSession: async () => {
      const session = {
        ended: false,
        async withTransaction(fn) {
          await fn();
        },
        async endSession() {
          session.ended = true;
        },
      };
      sessions.push(session);
      return session;
    },
  });
  const ops = (name) => models.log.filter((entry) => entry.op === name);
  return { repo, ops, sessions };
}

test('FR-13.4: every delete and scrub shares ONE session, each scoped to the tenant and the customer', async () => {
  const { repo, ops, sessions } = repoWith();
  const result = await repo.deidentifyCustomer(CTX, { userId: 'user-1', customerId: 'cust-1', now: NOW });

  assert.deepEqual(result, { messages: 12, conversations: 2, ticketsScrubbed: 1 });
  assert.equal(sessions.length, 1);
  const [session] = sessions;

  assert.deepEqual(ops('Conversation.find')[0].filter, { customerId: 'cust-1', tenantId: 't1' });
  assert.equal(ops('Conversation.find.session')[0].session, session);

  const [messages] = ops('Message.deleteMany');
  assert.deepEqual(messages.filter, { conversationId: { $in: ['conv-1', 'conv-2'] }, tenantId: 't1' });

  const [conversations] = ops('Conversation.deleteMany');
  assert.deepEqual(conversations.filter, { customerId: 'cust-1', tenantId: 't1' });

  const [tickets] = ops('Ticket.updateMany');
  assert.deepEqual(tickets.filter, { customerId: 'cust-1', tenantId: 't1' });
  assert.deepEqual(tickets.update, { $set: { note: null } });

  const [customer] = ops('Customer.updateOne');
  assert.deepEqual(customer.filter, { _id: 'cust-1', tenantId: 't1' });
  assert.deepEqual(customer.update, { $set: { displayName: null, email: null, externalRef: null, deidentifiedAt: NOW } });

  const [user] = ops('User.deleteOne');
  assert.deepEqual(user.filter, { _id: 'user-1', customerId: 'cust-1', tenantId: 't1' });

  for (const write of [messages, conversations, tickets, customer, user]) {
    assert.equal(write.options.session, session, write.op);
  }
  assert.equal(session.ended, true);
});

test('ADR 0006: deletion never reaches an audit collection', async () => {
  // The fake audit models throw on any use; reaching this line means none was used.
  const { repo } = repoWith();
  await repo.deidentifyCustomer(CTX, { userId: 'user-1', customerId: 'cust-1', now: NOW });
});

test('a customer with no conversations deletes no messages, and asks nothing of Message', async () => {
  const { repo, ops } = repoWith({ conversations: [] });
  const result = await repo.deidentifyCustomer(CTX, { userId: 'user-1', customerId: 'cust-1', now: NOW });
  assert.equal(ops('Message.deleteMany').length, 0);
  assert.equal(result.messages, 0);
});

test('an account already deleted by another request aborts the whole transaction', async () => {
  const { repo, sessions } = repoWith({ usersDeleted: 0 });
  await assert.rejects(
    repo.deidentifyCustomer(CTX, { userId: 'user-1', customerId: 'cust-1', now: NOW }),
    (error) => error.status === 404,
  );
  assert.equal(sessions[0].ended, true);
});

test('the password hash is read only for the user being deleted, within the tenant', async () => {
  const { repo, ops } = repoWith();
  await repo.findUserWithHash(CTX, 'user-1');
  assert.deepEqual(ops('User.findOne')[0].filter, { _id: 'user-1', tenantId: 't1' });
  assert.equal(ops('User.findOne.select')[0].fields, '+passwordHash');
});
