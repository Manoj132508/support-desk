import test from 'node:test';
import assert from 'node:assert/strict';
import { composeProblems } from '../../deploy/composeRules.mjs';

/**
 * Phase 15: the rules docker-compose.yml is checked against in CI. The fixture
 * is the file's wiring in the normalised shape `docker compose config --format
 * json` prints; each test breaks one decision and expects it named.
 */

const TOKEN = 'a-service-token-long-enough-for-production-use';
const URI = 'mongodb://mongo:27017/ai-support-desk?replicaSet=rs0';

function deployment() {
  return {
    services: {
      mongo: { command: ['mongod', '--replSet', 'rs0', '--bind_ip_all'] },
      'mongo-init': { depends_on: { mongo: { condition: 'service_healthy', required: true } } },
      indexes: {
        environment: { NODE_ENV: 'production', MONGODB_URI: URI },
        depends_on: { 'mongo-init': { condition: 'service_completed_successfully', required: true } },
      },
      ai: { environment: { AI_ENVIRONMENT: 'production', AI_SERVICE_TOKEN: TOKEN } },
      api: {
        init: true,
        stop_grace_period: '15s',
        environment: { MONGODB_URI: URI, TRUST_PROXY_HOPS: '1', AI_SERVICE_TOKEN: TOKEN },
        depends_on: {
          indexes: { condition: 'service_completed_successfully', required: true },
          ai: { condition: 'service_started', required: true },
        },
      },
      client: {
        ports: [{ mode: 'ingress', target: 80, published: '5179', protocol: 'tcp' }],
        depends_on: { api: { condition: 'service_healthy', required: true } },
      },
    },
  };
}

const broken = (change) => {
  const config = deployment();
  change(config.services);
  return composeProblems(config);
};

test('the deployment as designed has no problems', () => {
  assert.deepEqual(composeProblems(deployment()), []);
});

test('the short port form written in the file is read too', () => {
  const config = deployment();
  config.services.client.ports = ['${CLIENT_PORT:-5179}:80'];
  assert.deepEqual(composeProblems(config), []);
});

test('publishing the API port is refused: its trusted hop would believe a forged header', () => {
  const problems = broken((s) => (s.api.ports = ['4400:4400']));
  assert.ok(problems.some((p) => p.startsWith('api publishes a port')));
});

test('publishing the AI service or MongoDB is refused', () => {
  assert.ok(broken((s) => (s.ai.ports = ['8200:8200'])).some((p) => p.startsWith('ai publishes')));
  assert.ok(broken((s) => (s.mongo.ports = ['27017:27017'])).some((p) => p.startsWith('mongo publishes')));
});

test('trusting any number of proxy hops but one is refused', () => {
  for (const hops of ['0', '2', undefined]) {
    assert.ok(broken((s) => (s.api.environment.TRUST_PROXY_HOPS = hops)).some((p) => p.includes('TRUST_PROXY_HOPS')), String(hops));
  }
});

test('a standalone MongoDB, or an API not told the replica set, is refused', () => {
  assert.ok(broken((s) => (s.mongo.command = ['mongod', '--bind_ip_all'])).includes('mongo must run as replica set rs0'));
  assert.ok(
    broken((s) => (s.api.environment.MONGODB_URI = 'mongodb://mongo:27017/ai-support-desk')).includes('api MONGODB_URI must name replicaSet=rs0'),
  );
});

test('an API that starts before its indexes exist is refused', () => {
  const problems = broken((s) => (s.api.depends_on.indexes.condition = 'service_started'));
  assert.ok(problems.includes('api must wait for indexes (service_completed_successfully)'));
});

test('indexes applied to a different database from the one the API uses are refused', () => {
  const problems = broken((s) => (s.indexes.environment.MONGODB_URI = 'mongodb://mongo:27017/other?replicaSet=rs0'));
  assert.ok(problems.includes('indexes must apply indexes to the database the api uses'));
});

test('an API held back until the AI service is healthy is refused (FR-14.3)', () => {
  const problems = broken((s) => (s.api.depends_on.ai.condition = 'service_healthy'));
  assert.ok(problems.some((p) => p.includes('FR-14.3')));
});

test('without init, or with too short a stop grace period, clean shutdown is refused', () => {
  assert.ok(broken((s) => delete s.api.init).includes('api needs init: true so SIGTERM reaches Node'));
  for (const grace of ['10s', '5s', undefined]) {
    assert.ok(broken((s) => (s.api.stop_grace_period = grace)).some((p) => p.includes('stop_grace_period')), String(grace));
  }
  assert.deepEqual(broken((s) => (s.api.stop_grace_period = '1m')), []);
});

test('two different service tokens, or an AI service outside production mode, are refused', () => {
  assert.ok(broken((s) => (s.ai.environment.AI_SERVICE_TOKEN = 'another')).includes('api and ai must use the same AI_SERVICE_TOKEN'));
  assert.ok(broken((s) => (s.ai.environment.AI_ENVIRONMENT = 'development')).some((p) => p.startsWith('ai must run with')));
});

test('a missing service is named rather than crashing the check', () => {
  assert.deepEqual(broken((s) => delete s['mongo-init']), ['service "mongo-init" is missing']);
});
