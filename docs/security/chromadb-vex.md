# ChromaDB advisory assessment

Reviewed: 2026-10-22

ChromaDB 1.5.9 is affected by four published advisories for which no fixed
release is currently available:

| Advisory | Affected capability | Status in this application |
|---|---|---|
| PYSEC-2026-311 / CVE-2026-45829 | Unauthenticated code injection through Chroma's HTTP collection API | Not reachable |
| PYSEC-2026-3814 / CVE-2026-45833 | Authenticated code injection through Chroma's HTTP collection API | Not reachable |
| PYSEC-2026-3813 / CVE-2026-45830 | Cross-tenant access in Chroma server authorisation | Not applicable |
| PYSEC-2026-3815 / CVE-2026-45831 | Scope failure in Chroma's RBAC provider | Not applicable |

## Why the vulnerable paths are not reachable

- The AI service instantiates `chromadb.PersistentClient` in-process. It does
  not start or connect to a Chroma HTTP server.
- The application exposes no Chroma endpoint and does not configure Chroma's
  authentication or RBAC providers.
- Collection names and the embedding function are application-controlled.
  Requests cannot supply a model repository or set `trust_remote_code`.
- The AI service is advisory-only and receives requests through the Express
  service using an internal service token. It holds no business-data write
  credentials.

These facts make the vulnerable server and multi-tenant authorisation paths
unreachable in the shipped topology. The dependency audit therefore carries
explicit, documented exceptions rather than silently suppressing all ChromaDB
findings.

## Removal condition

Remove the four `pip-audit --ignore-vuln` entries as soon as Chroma publishes a
fixed release that passes the retrieval evaluation. Re-open this assessment if
the architecture ever introduces a Chroma HTTP service, remote Chroma client,
Chroma authentication/RBAC, user-selected embedding functions, or untrusted
collection configuration.

References:

- https://osv.dev/vulnerability/PYSEC-2026-311
- https://osv.dev/vulnerability/PYSEC-2026-3813
- https://osv.dev/vulnerability/PYSEC-2026-3814
- https://osv.dev/vulnerability/PYSEC-2026-3815
