import { SHUTDOWN_GRACE_MS } from '../server/src/shutdown.js';

/**
 * What docker-compose.yml must keep true. Phase 15.
 *
 * Each rule is a decision some other part of the system depends on, and none
 * of them fails loudly when broken: a published API port still works, it just
 * lets a forged header past the sign-in limiter. So they are checked.
 *
 * Takes the configuration as `docker compose config --format json` prints it,
 * which is how CI runs it (deploy/check-compose.mjs), and also accepts the
 * short forms written in the file itself.
 */

const seconds = (value) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2] === 'ms' ? amount / 1000 : match[2] === 'm' ? amount * 60 : amount;
};

const condition = (service, dependency) => {
  const entry = service?.depends_on?.[dependency];
  return typeof entry === 'object' ? entry.condition : null;
};

/** The container ports a service publishes to the host. */
const published = (service) =>
  (service?.ports ?? []).map((port) => (typeof port === 'object' ? Number(port.target) : Number(String(port).split(':').pop())));

export function composeProblems(config) {
  const problems = [];
  const services = config?.services ?? {};
  const { mongo, 'mongo-init': mongoInit, indexes, ai, api, client } = services;

  for (const name of ['mongo', 'mongo-init', 'indexes', 'ai', 'api', 'client']) {
    if (!services[name]) problems.push(`service "${name}" is missing`);
  }
  if (problems.length > 0) return problems;

  // ADR 0001, and the API's single trusted proxy hop.
  for (const [name, service] of Object.entries(services)) {
    const ports = published(service);
    if (name === 'client') {
      if (ports.length !== 1 || ports[0] !== 80) problems.push('client must publish exactly nginx port 80');
    } else if (ports.length > 0) {
      problems.push(`${name} publishes a port; only the client may be reachable from outside`);
    }
  }
  if (String(api.environment?.TRUST_PROXY_HOPS) !== '1') {
    problems.push('api must trust exactly one proxy hop (TRUST_PROXY_HOPS=1): nginx');
  }

  // Transactions need a replica set, and the API must be told its name.
  const command = [mongo.command ?? []].flat().join(' ');
  if (!/--replSet rs0\b/.test(command)) problems.push('mongo must run as replica set rs0');
  for (const [name, service] of [['api', api], ['indexes', indexes]]) {
    if (!String(service.environment?.MONGODB_URI ?? '').includes('replicaSet=rs0')) {
      problems.push(`${name} MONGODB_URI must name replicaSet=rs0`);
    }
  }
  if (api.environment?.MONGODB_URI !== indexes.environment?.MONGODB_URI) {
    problems.push('indexes must apply indexes to the database the api uses');
  }

  // Startup order: nothing uses the database before its indexes exist.
  const order = [
    [mongoInit, 'mongo-init', 'mongo', 'service_healthy'],
    [indexes, 'indexes', 'mongo-init', 'service_completed_successfully'],
    [api, 'api', 'indexes', 'service_completed_successfully'],
    [client, 'client', 'api', 'service_healthy'],
  ];
  for (const [service, name, dependency, expected] of order) {
    if (condition(service, dependency) !== expected) problems.push(`${name} must wait for ${dependency} (${expected})`);
  }
  if (['service_healthy', 'service_completed_successfully'].includes(condition(api, 'ai'))) {
    problems.push('api must not wait for the AI service to be healthy: the desk serves people without it (FR-14.3)');
  }

  // Clean shutdown needs the signal delivered, and time to use it.
  if (api.init !== true) problems.push('api needs init: true so SIGTERM reaches Node');
  const grace = seconds(api.stop_grace_period);
  if (grace === null || grace <= SHUTDOWN_GRACE_MS / 1000) {
    problems.push(`api stop_grace_period must exceed the API's own ${SHUTDOWN_GRACE_MS / 1000} s shutdown grace`);
  }

  // The two tiers must share one service token, and the AI tier fail closed.
  if (!api.environment?.AI_SERVICE_TOKEN || api.environment.AI_SERVICE_TOKEN !== ai.environment?.AI_SERVICE_TOKEN) {
    problems.push('api and ai must use the same AI_SERVICE_TOKEN');
  }
  if (ai.environment?.AI_ENVIRONMENT !== 'production') {
    problems.push('ai must run with AI_ENVIRONMENT=production, which refuses calls without the token');
  }

  return problems;
}
