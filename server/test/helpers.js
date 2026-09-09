import { createApp } from '../src/app.js';

/**
 * Start the app on an OS-chosen port, run a function against it, shut it down.
 *
 * Port 0 means "any free port". That is what makes these tests safe to run
 * while a dev server is up on 4400, and safe to run in parallel with each
 * other -- neither of which is true of a hard-coded test port.
 */
export async function withServer(run) {
  const app = createApp();
  const server = app.listen(0);

  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    return await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Fetch plus the parsed body, since every assertion here wants both. */
export async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body, status: response.status };
}
