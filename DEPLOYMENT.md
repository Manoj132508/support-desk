# Deploying the AI Support Desk

The whole system runs with Docker Compose: nginx serving the client, the Express API, the Python
AI service, and MongoDB as a replica set. The model runs in Ollama on the host.

> **Not built on the development machine.** Docker is not installed there (Phase 1 §8). The images
> and compose file are built, started and checked by the
> [Deploy check](.github/workflows/deploy.yml) workflow on GitHub's runners, on every push. What
> that workflow proves, and what it does not, is in
> [Phase 15](docs/phases/phase-15-deployment-and-ci.md).

---

## Run it

```bash
cp .env.compose.example .env
```

Set `JWT_SECRET` and `AI_SERVICE_TOKEN` in `.env`, each at least 32 characters. One way to make one:

```bash
node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
```

```bash
docker compose up --build
```

Then open <http://localhost:5179>. The first build takes several minutes, mostly for the AI image,
which installs torch and bakes in the embedding model.

### What starts, in order

| Service | Does | Published |
|---|---|---|
| `mongo` | MongoDB 8.0, started as replica set `rs0` | no |
| `mongo-init` | Initiates the replica set once; a no-op on every later start; then exits | no |
| `indexes` | Creates the declared indexes and drops undeclared ones; then exits | no |
| `ai` | The AI service. On start it indexes the bundled help centre and warms the model | no |
| `api` | The Express API. Starts only after `indexes` succeeds | no |
| `client` | nginx: serves the app and proxies `/api` | **5179** |

**Only nginx is published, and that is a security property.** The API reads each client's address
from `X-Forwarded-For`, trusting exactly one proxy hop (`TRUST_PROXY_HOPS=1`), and that hop is
nginx. Publish port 4400 and a caller's own forged header is believed, so the sign-in rate limit
stops working ([ADR 0001](docs/adr/0001-three-tier-architecture.md), amended).

---

## Things that will bite

### Signing in over plain HTTP fails in production mode

With `NODE_ENV=production` the session cookie is `Secure`, and browsers never send a `Secure` cookie
over `http://`. Either:

- **For real use,** terminate TLS in front of nginx, with a load balancer or a reverse proxy
  holding the certificate. That layer should also send `Strict-Transport-Security`, which nginx
  here does not.
- **For a local trial,** set `NODE_ENV=development` in `.env`. That also relaxes the production
  refusals and lets the demo seed run (below), so don't use it anywhere real.

### The AI service has to reach Ollama on the host

The container calls `AI_OLLAMA_BASE_URL`, by default `http://host.docker.internal:11434`.

- **Docker Desktop (Windows, macOS):** works as is.
- **Linux:** compose maps `host.docker.internal` to the host, but Ollama listens only on
  `127.0.0.1` by default. Start it with `OLLAMA_HOST=0.0.0.0` (or the Docker bridge address) and
  keep port 11434 firewalled from everything else.
- **The model must already be pulled:** `ollama pull llama3.1:8b`, or whatever `AI_MODEL` names.
- **Without a working GPU,** set `AI_NUM_GPU=0` to keep the model on the CPU. Phase 14 measured
  what that costs.

If Ollama can't be reached, the AI service still starts, logs a failed warm-up, and reports healthy
(FR-14.3). Questions that need the model can't be answered until Ollama is reachable. Proposals,
handoffs to a person and requests for an order number never call the model, so they keep working,
and so does the agent console.

### Indexes are a deploy step, and the API will not start without them

Some indexes are guarantees. The unique index on the idempotency key is what stops a confirmation
from executing twice (ADR 0003).

- **In production:** the API never builds indexes itself, and refuses to start while a declared one
  is missing. The `indexes` service applies them before every start.
- **Against an existing database** (moving to this version, say):

  ```bash
  docker compose run --rm indexes node scripts/indexes.js
  ```

  That reports any drift without changing anything. `--apply` reconciles it. It drops indexes the
  models don't declare, so an index added by hand belongs in a model.

### One API instance

The rate limiter counts in memory, per process (Phase 12). Two API replicas would each allow the full
limit, doubling it. Scaling the API needs a shared store for the limiter first.

Behind more than one proxy (a load balancer *and* nginx), set `TRUST_PROXY_HOPS` to the real number
of hops. Otherwise every customer is counted as the load balancer's address and shares one bucket.

### MongoDB has no authentication here

It is reachable only on the compose network and never published. Before a real deployment, either
use a managed replica set such as MongoDB Atlas (set `MONGODB_URI` accordingly and drop the `mongo`
and `mongo-init` services), or enable authentication. A replica set with authentication also needs
a key file.

---

## Operating it

| Task | Command |
|---|---|
| Demo data (only with `NODE_ENV=development`; the seed refuses production) | `docker compose run --rm api node scripts/seed.js` |
| Expire stale pending proposals (run on a schedule) | `docker compose run --rm api node scripts/sweep.js` |
| Check indexes against the models | `docker compose run --rm indexes node scripts/indexes.js` |
| Re-index the help centre after editing it | Rebuild the `ai` image. The index is rebuilt from the bundled articles on every start |
| Back up the data | Back up the `mongo_data` volume, or use `mongodump` against the replica set |
| Stop | `docker compose down`. Add `--volumes` only if you mean to delete the database |

The seeded accounts all use the password `demo-password-change-me`, with organisation `acme`. They
exist for demonstrations only, which is why the seed refuses to run in production.

**Stopping is clean.** The API handles SIGTERM: it stops accepting connections, lets requests
finish, closes streams still open after 10 seconds (recording those turns as cancelled),
disconnects from the database, and exits. `stop_grace_period` gives it 15 seconds.

---

## Security headers

nginx sends a strict Content Security Policy with the app, defined in
[`client/deploy/security-headers.conf`](client/deploy/security-headers.conf):

- **Allowed:** only this origin, plus `data:` images for Bootstrap's form controls.
- **Refused:** inline scripts, `eval`, and framing by any other site.

API responses carry helmet's headers instead. The policy was checked in a browser against the
production build, and the Deploy check workflow checks every header on the running stack.
