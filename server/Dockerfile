# The Express API: auth, tenancy, the policy engine, action execution and the
# audit. Ported from Project 2. Build context: server/.
#
# One image, two uses in the compose deployment: the API itself, and the
# one-off `indexes` step that runs before it (scripts/indexes.js).

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, for layer caching. `npm ci` installs exactly the lockfile;
# `--omit=dev` because nothing that runs here needs a dev dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Plain ESM: no build step. .dockerignore keeps tests, the evals, the benchmarks
# and every .env file out of the image.
COPY . .

# The official image's unprivileged user. The API writes nothing to disk.
USER node

EXPOSE 4400

# Configuration comes from the environment the orchestrator injects: no
# --env-file here, unlike the dev script. In production the API refuses to
# start without its secrets (Phase 12) or its indexes (Phase 15), and exits
# non-zero so the platform sees it.
#
# /api/health answers 200 even when the AI service is down, on purpose (FR-14.3):
# the desk still serves people. So this checks the process, not its dependencies.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4400/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# `node` directly, not `npm start`: npm does not pass SIGTERM on to its child,
# and the API's clean shutdown depends on receiving it (src/shutdown.js).
CMD ["node", "src/index.js"]
