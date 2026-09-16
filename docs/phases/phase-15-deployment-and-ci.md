# Phase 15 — Deployment and CI

**Project 3 · AI Support Desk**
Status: **complete, pending its first CI run.** Delivers NFR-7 (runs via Docker Compose) and NFR-9
(conventional commits, CI green), plus four items earlier phases deferred here. Nothing Docker has
run yet; what that leaves unverified is in §8.

---

## 1. Scope

| Requirement | Target |
|---|---|
| NFR-7 | Runs via Docker Compose. Images authored and inputs verified but not built on this machine, because Docker is not installed; stated plainly in the README |
| NFR-9 | Conventional commits, one per meaningful step; CI green from the first phase that has code |

**Deferred to this phase:**

- **The client's Content Security Policy.** Phase 12 left it to "the built client's hosting".
- **Index sync.** Phase 14 changed the queue indexes, and existing databases keep the old ones.
- **The rate limiter's per-process counts.** Phase 12: "either shares the store or states the
  multiplier".
- **Auditing Python dependencies.** Phase 12 had no `pip-audit`.

**The port check ADR 0001 left for this phase:** "Deployment config exposes 5179 and 4400 only".

---

## 2. Before building

`git fsck` was clean and the working tree was clean. The suites stood at server 556, client 144 and
AI service 131.

**CI on GitHub had run twice, and both runs passed:** `176ed54` and `434455c`, checked through the
GitHub API. Phase 14's 11 commits were not yet pushed. Docker is still not installed.

Project 2's images, compose file and nginx configuration were the starting point. This deployment
needed things Project 2's did not: a replica set, a proxy the rate limiter depends on, indexes that
are guarantees, a model the grounding threshold was tuned on, and a CSP.

---

## 3. Findings

Each finding was confirmed before it was fixed, and each fix has a test.

| # | Finding | Fixed by |
|---|---|---|
| 1 | **Publishing the API port would disable the sign-in limit.** The API trusts one proxy hop when it reads the client address the limiter counts. Reached directly, it believes a caller's own `X-Forwarded-For`. Demonstrated: 21 attempts with a rotating forged header were never limited | Only nginx is published; ADR 0001 is amended. The hop count is `TRUST_PROXY_HOPS`, because the right number belongs to the deployment. Behind a load balancer *and* nginx it is 2 |
| 2 | **Nothing handled SIGTERM.** `docker stop` killed the API mid-request after its grace period | `src/shutdown.js`: stop accepting, let requests finish, close streams still open after 10 s (the route records them as cancelled turns), disconnect, exit. Compose adds `init: true` and a 15 s grace |
| 3 | **Index builds could fail silently.** Mongoose builds indexes at startup, and a failed build is an event nothing listens to. Some indexes are guarantees: the unique idempotency key is what stops a confirmation executing twice | `npm run indexes` (check, or `--apply`). Production never builds indexes automatically, and the API **refuses to start** while a declared index is missing. Extra indexes only warn |
| 4 | **A new deployment's index was empty** until someone called `/ingest`; every question meanwhile was offered a person | The AI service indexes its bundled help centre at startup when the index is empty, then warms the model |
| 5 | **`.env.compose.example` would have been ignored twice.** `.gitignore` ignored every `.env.*` except `.env.example`, and the secrets scan skipped the same names as private files | Both rules now let `*.example` through; a test checks that both examples, the compose file, the Dockerfiles and the nginx config are scanned |
| 6 | **nginx header inheritance fails silently in both directions.** A location with its own `add_header` loses the server's headers, which would strip the CSP from `index.html` and the assets. A location with none inherits them all. **My own first draft** included the headers at server level, which would have doubled helmet's on every API response | Headers are included per location, never at server level and never on `/api/`; a test checks both, and fails against the first draft |
| 7 | **Container files would become CRLF** on a Windows checkout, which breaks shell lines and config inside Linux images | `.gitattributes` keeps them LF |
| 8 | **`CLIENT_ORIGIN` is read by nothing.** The app is same-origin, so it has no CORS | Not set in compose; recorded (§8) |

**Two tools I wrote had faults of their own:**

- **The limiter test took 24 s.** Sign-in runs a full bcrypt comparison even for an empty body, on
  purpose, so a missing account costs the same time as a wrong password. The test now counts
  attempts through registration, which shares the limiter and rejects an empty body in 6 ms, and
  takes 1.8 s.
- **The smoke test's first reachability check passed with a mongod listening on the port.** It used
  `fetch`, and MongoDB accepts a connection and then doesn't speak HTTP, so the failed request looked
  like a refusal. It now opens a TCP connection.

---

## 4. The deployment

`docker compose up --build`. [DEPLOYMENT.md](../../DEPLOYMENT.md) covers running and operating it.

```
mongo ─▶ mongo-init ─▶ indexes ─▶ api ─▶ client (nginx, the only published port: 5179)
                                  ai ─┘
```

- **`mongo`** runs as replica set `rs0`, because execution is one multi-document transaction. The
  member is named `mongo:27017`, the address the API resolves: a replica set tells clients its
  members' names, so a member named `localhost` would send the API to its own container.
- **`mongo-init`** initiates the set, waits for a primary, and exits. On every later start it
  finds the set already initiated and changes nothing.
- **`indexes`** is the API image running `scripts/indexes.js --apply`. The API waits for it to
  succeed.
- **`ai`** pins CPU torch 2.13.0, the version Phase 13's baseline and Phase 14's measurements ran
  with. The embedding model is **baked in, with the model hub switched off**. The 0.51 threshold
  was tuned on that model's scores, so a container that fetched whatever the hub served at startup
  could change which questions are handed to a person, with nothing logged. The index lives in the
  container and is rebuilt from the bundled articles on every start (about 0.3 s), so it can never
  keep chunks of an article a newer image removed.
- **`api`** runs `node src/index.js` directly: `npm start` would not pass SIGTERM on to it. It
  waits for the AI service to *start*, not to be healthy, because the desk serves people without it
  (FR-14.3).
- **`client`** is nginx with the app, the `/api` proxy (buffering off, for streamed turns), and the
  security headers.

**The CSP** allows only this origin and `data:` images (Bootstrap draws form controls from them).
It forbids inline scripts, `eval`, other origins, and framing by another site (ADR 0009's
confirmation dialog must not be clicked through from one).

**`deploy/composeRules.mjs`** names the decisions the compose file must keep:

- one published port, and one trusted hop;
- a replica set, and the same database for `indexes` and `api`;
- the startup order;
- `init` and a stop grace period longer than the API's own;
- one shared service token, and the AI service in production mode.

---

## 5. Verified on this machine

Docker is not installed, so every part that could run without it was run.

| What | How | Result |
|---|---|---|
| The API's production index refusal | A production API against an empty database on the replica set | **Refused, exit 1**, naming every missing index by model |
| The index deploy step | `scripts/indexes.js --apply`, then a second check | Indexes created for all 12 models; the check reports a match |
| Production start after that | Same API, same database | Started and answered health 200, with helmet's HSTS header |
| Configuration from the environment only | `node src/index.js` with no `--env-file` | Started and answered health |
| The index check against the demo database | `npm run indexes` (read only) | Reported the two queue indexes Phase 14 superseded; exit 1; nothing changed |
| AI service startup on an empty index | uvicorn with the real embedder and Chroma, an empty index directory, no Ollama | Indexed 3 documents, 7 chunks, in 311 ms; warm-up failed cleanly with `ConnectError`; health `ok` |
| **The CSP against the production build** | `vite build`, served with the headers read from `security-headers.conf`, in a browser | Loaded with no violation. The deep link `/console/tickets` reached the router; 1,419 CSS rules applied; React's `style` prop worked (380 px). **Enforced:** an injected inline script was refused and never ran, and a remote image was refused. Bootstrap's `data:` SVG checkbox drew |
| The compose wiring | The real `docker-compose.yml` parsed and run through `composeRules.mjs` | No problems; a copy with the API port published was refused, exit 1 |
| The smoke script itself | Dry run against the local build server | All checks ran. The 4 failures were the ones the stand-in could not satisfy: no AI service, no Cache-Control, the dev API on 4400 |
| Every workflow and the compose file | Parsed as YAML | All parse |
| Signal handling | Not possible here | Git Bash cannot deliver a POSIX signal to a native Windows process, and Node on Windows terminates on SIGTERM without running handlers. Unit-tested with fakes; CI checks the log line on Linux |

---

## 6. CI

| Workflow | When | What it gates |
|---|---|---|
| `ci.yml` | Every push and pull request | The three test suites; the client build; the policy eval (unauthorised actions exactly 0) |
| **`deploy.yml`** (new) | Every push to main, pull requests, on demand | Compose wiring → build the three images → start the stack → the smoke test (below) → indexes match → replica-set initiation is a no-op on rerun → the API logs a clean shutdown on SIGTERM |
| `eval.yml` | Weekly, on demand | The escalation eval against its baseline; torch now pinned to 2.13.0 |
| **`audit.yml`** (new) | Weekly, on demand, when a dependency file changes on main | `npm audit` of production dependencies at `high`, per package; `pip-audit` over the environment the AI image installs |

**The smoke test** (`deploy/smoke.mjs`) runs against the stack as a browser meets it:

- health reports the database and the AI service `ok` through nginx;
- the exact CSP from `security-headers.conf` is on `index.html`, on a client route and on a hashed
  asset, beside that asset's own Cache-Control;
- API responses carry helmet's headers once, not joined with nginx's;
- a sign-in reaches the database through nginx and is refused with 401;
- ports 4400, 8200 and 27017 refuse TCP connections.

**The audit threshold is `high`.** Phase 12 recorded two moderate react-router advisories, one
mitigated in code and one in server-side rendering this app does not use. Failing on them every
week would teach everyone to ignore the job.

**NFR-9.** All 122 commits in the history follow the conventional format: feat 61, docs 30, test
10, fix 10, perf 7, ci 3, chore 1. CI passed on both commits pushed so far.

---

## 7. Deviations from the plan

| Plan | What happened | Why |
|---|---|---|
| Deployment exposes 5179 and 4400 (ADR 0001) | 5179 only | Finding 1; ADR 0001 amended |
| NFR-7: "images authored and inputs verified" | Also built, started and checked on every push, by CI on GitHub's runners | GitHub's runners have Docker, so being unable to build locally did not mean the images could go unbuilt |
| Project 2 left baking the embedding model optional | Baked in, with the hub off | The grounding threshold depends on the exact model |
| Phase 12: "share the rate-limit store or state the multiplier" | Stated: one API replica; two would each allow the full limit | A shared store is a scaling change, not a deployment one |

---

## 8. Honestly unverified, and deferred

- **Nothing Docker has run.** `deploy.yml` has never run, so the images have never been built,
  nginx has never loaded its configuration, and `mongo-init`'s script has never executed. The
  first run will say whether any of it is wrong. This phase is complete in the sense that
  everything that could be checked here was; the rest waits on that run.
- **`audit.yml` has never run either,** so its first results are unknown.
- **Signal handling on Linux** is covered only by the unit tests and the CI step not yet run (§5).
- **A container reaching Ollama on the host** was not tried. On Linux, Ollama has to listen beyond
  loopback (DEPLOYMENT.md).
- **A question that needs the model while Ollama is down** was not exercised end to end.
- **MongoDB runs without authentication,** reachable only on the compose network. A real
  deployment needs a managed replica set such as Atlas, or authentication with a key file.
- **TLS and HSTS are left to whatever terminates HTTPS in front of nginx.** Over plain HTTP in
  production mode, the Secure session cookie means signing in does not work (DEPLOYMENT.md).
- **One API replica,** because the limiter counts per process.
- **The expiry sweep is not scheduled.** DEPLOYMENT.md gives the command to run on a schedule.
- **`CLIENT_ORIGIN`** is configuration nothing reads.
- **The demo database** still holds the two superseded queue indexes; `npm run indexes -- --apply`
  removes them.
- **The README's full rewrite** is Phase 16. This phase updated only its status, the deployment
  statement NFR-7 requires, and the document table.

---

## 9. Verification

**Tests.** Server **582** (+26), client **151** (+7), AI service **134** (+3). Several were also run
against the code before its fix and seen to fail:

- the proxy hop count;
- the nginx header rules, against my own first draft;
- the compose rules, against a copy with the API port published;
- the startup index behaviour.

**Local checks** are in §5. The CI checks are in §6, and they run on the next push.
