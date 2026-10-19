# Graph Analysis Platform — Backend

Backend for the Backslash Security home assignment. You upload a JSON file that describes a microservice
architecture as a directed graph (services, databases, queues, the calls between them, and their
vulnerabilities). The API stores it, and answers questions such as *"which routes lead from a publicly
exposed service to a database, passing through a vulnerable service?"* with filters you can define yourself.

**Stack:** Node.js · TypeScript · Express 5 · PostgreSQL · Prisma 7 · Zod · OpenAPI/Swagger · pino · Jest · Supertest · Docker Compose

## Quick start

```bash
npm install
docker compose up --build        # PostgreSQL + the API, migrations applied automatically
npm run seed                     # (optional, in another terminal) load the sample graph
```

Then open **http://localhost:3000/docs** (Swagger UI), or:

```bash
curl -F "name=Train Ticket" -F "file=@fixtures/train-ticket-be.json" http://localhost:3000/api/v1/graphs
# -> {"id":"…","version":1,"nodeCount":47,"edgeCount":98,"placeholders":["assurance-service"],…}

curl "http://localhost:3000/api/v1/graphs/<id>/routes?through=vulnerable&end=sink"
```

## Requirements

- Node.js 22 or later (developed on Node 26)
- Docker with Docker Compose

## Configuration: the `.env` file

All configuration lives in a single `.env` file in the project root. There is no other env file,
so create it from the block below:

```dotenv
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

POSTGRES_USER=backslash
POSTGRES_PASSWORD=backslash
POSTGRES_DB=graphs
POSTGRES_PORT=5432

# Host is "localhost" for a locally running backend; docker compose overrides it to "postgres".
DATABASE_URL=postgresql://backslash:backslash@localhost:5432/graphs

CORS_ORIGINS=http://localhost:5173
MAX_UPLOAD_BYTES=10485760
MAX_NODES=50000
MAX_EDGES=500000

# Graphs kept in memory for fast route queries (least recently used is dropped beyond this).
GRAPH_CACHE_MAX_ENTRIES=50
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`, `test` or `production` |
| `PORT` | no | `3000` | HTTP port |
| `LOG_LEVEL` | no | `info` | pino level (`fatal` … `trace`, `silent`) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | for Docker | – | Used by the Postgres container and by compose to build the backend's `DATABASE_URL` |
| `POSTGRES_PORT` | no | `5432` | Host port the Postgres container is published on |
| `DATABASE_URL` | **yes** | – | Connection string used by the backend, Prisma CLI and tests |
| `CORS_ORIGINS` | no | `http://localhost:5173` | Comma-separated list of allowed frontend origins |
| `MAX_UPLOAD_BYTES` | no | `10485760` (10 MB) | Largest accepted graph file |
| `MAX_NODES` / `MAX_EDGES` | no | `50000` / `500000` | Largest accepted graph |
| `GRAPH_CACHE_MAX_ENTRIES` | no | `50` | How many graphs are kept in memory for fast route queries; beyond this the least recently used one is dropped and reloaded from PostgreSQL when needed. Each graph costs roughly its size in nodes and edges, so lower it for very large graphs |

Everything is validated with Zod at startup, and the server refuses to start with a list of every invalid variable.
If the password contains URL-special characters, URL-encode it inside `DATABASE_URL`.

## Running

```bash
# Option A: everything in Docker
docker compose up --build

# Option B: database in Docker, backend locally with hot reload
docker compose up -d postgres
npm run dev

# Backend container alone (expects a reachable database)
docker compose up --no-deps backend
```

- API: `http://localhost:3000/api/v1`
- Health: `http://localhost:3000/health`
- Swagger UI: `http://localhost:3000/docs` (raw spec at `/docs/openapi.json`)

The backend container runs `prisma migrate deploy` before starting, and waits until the Postgres healthcheck passes.
On `SIGTERM`/`SIGINT` it finishes in-flight requests, closes the database connections and exits.

### Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start with hot reload (`tsx watch`) |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run typecheck` | `tsc --noEmit` over sources and tests |
| `npm test` | All tests (unit and integration) |
| `npm run test:unit` | Unit tests only, no database needed |
| `npm run test:integration` | API and database tests; Postgres must be running |
| `npm run seed [-- file.json [name]]` | Load a graph file (default `fixtures/train-ticket-be.json`) through the normal service code |
| `npm run prisma:migrate` / `npm run prisma:deploy` | Create a migration (dev) / apply migrations |

## API

The interactive reference is the Swagger UI at `/docs`; it is generated from the same Zod schemas that validate requests,
so it cannot drift from the code.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness plus a database check (`200` / `503`) |
| POST | `/api/v1/graphs` | Create a graph from an uploaded JSON file (`multipart/form-data`: `file`, `name`) |
| GET | `/api/v1/graphs` | List graph summaries, newest first |
| GET | `/api/v1/graphs/:id` | The graph with its nodes and edges; the `ETag` is its version |
| PUT | `/api/v1/graphs/:id` | Atomically replace nodes and edges from a new file (`file`, optional `name`, optional `If-Match`) |
| PATCH | `/api/v1/graphs/:id` | Rename (`{"name": "…"}`); the version is unchanged |
| DELETE | `/api/v1/graphs/:id` | Delete the graph with its nodes, edges and filters |
| GET | `/api/v1/graphs/:id/filters` | List the graph's filters with how many nodes each matches |
| POST | `/api/v1/graphs/:id/filters` | Create a custom filter (`{key, description?, definition}`) |
| POST | `/api/v1/graphs/:id/filters/preview` | Try a rule without saving it (`{definition}`) |
| GET / PUT / DELETE | `/api/v1/graphs/:id/filters/:key` | Read, replace or delete one filter (built-in filters are read-only) |
| GET | `/api/v1/graphs/:id/routes?start=&end=&through=` | The subgraph of all routes matching the filters |

### Uploading a graph

```bash
curl -F "name=Train Ticket" -F "file=@fixtures/train-ticket-be.json" http://localhost:3000/api/v1/graphs
```

- Only JSON is accepted: the file must be named `*.json` or be sent as `application/json` (otherwise `415`).
- The content is always validated, whatever the file name or content type claims: it must be UTF-8 JSON of the right shape (`400 INVALID_JSON` / `400 VALIDATION_ERROR` with the exact field paths).
- Nodes need a `name` and a `kind`. `language`, `path`, `publicExposed`, `vulnerabilities` and `metadata` are optional and type-checked when present. `severity` is any string.
- **Unknown fields are preserved at every level**, never validated and never dropped: on the file itself (returned as `extra` of the graph), on each node (`extra` of the node), on each edge (`extra` of the edge, left out when there is none) and inside vulnerabilities and `metadata` objects, which are kept whole.
  - An edge entry's unknown fields are copied onto every edge it expands to; when the same edge appears twice, their unknown fields are merged (the later entry wins on a conflicting key).
  - Replacing a graph replaces these fields too. Values are stored exactly; only the order of keys inside an object is not kept (PostgreSQL `jsonb` orders them itself).
  - The one exception: an object key named `__proto__` (at any depth) is refused with `400`, because Prisma would silently drop it and failing loudly is better than losing data. Other special names (`constructor`, `prototype`, `toString`, an empty key, …) are stored normally.
- An edge's `to` may be a string or an array. Edges are split into pairs, repeated edges are merged, self-loops are kept.
- Nodes that edges reference but the file does not define become **placeholder nodes** (name only, no invented data). The response lists them in `placeholders`. A placeholder never matches a filter, but it can lie on a route.
- Duplicate node names are rejected (`400 DUPLICATE_NODE_NAME`). Limits come from `.env`: a file over `MAX_UPLOAD_BYTES`, or a graph over `MAX_NODES` / `MAX_EDGES`, gets `413`.
- Graph names are required but need not be unique.
- Every new graph gets three read-only built-in filters: `public`, `sink` and `vulnerable`.

### Filters

A filter is **data**: a JSON rule stored per graph. Rules are validated when you save them (every problem is reported with its
exact path), compiled once when the graph is loaded into memory, and evaluated once per node, never per query.

A rule is exactly one of:

```jsonc
{ "all": [Rule, …] }                    // every rule matches
{ "any": [Rule, …] }                    // at least one rule matches
{ "not": Rule }
{ "field": "kind", "op": "in", "value": ["rds", "sql"] }
{ "field": "vulnerabilities", "op": "some", "where": { "field": "severity", "op": "eq", "value": "high" } }
```

| | |
|---|---|
| **Fields** | `name`, `kind`, `language`, `path`, `publicExposed`, `metadata.<key>`, `extra.<key>` (dotted paths go deeper, e.g. `metadata.db.engine`), and `vulnerabilities` (with `some`). Inside `where`, any field of a vulnerability, including unknown ones (`metadata.cwe`, `scanner`, …). `extra.<key>` reaches the unknown fields of a node. |
| **Operators** | `eq`, `neq`, `in`, `notIn`, `exists`, `notExists`, `contains` (case-sensitive substring), `gt`, `gte`, `lt`, `lte` (numbers only), `some` (only on `vulnerabilities`, with an optional `where`) |
| **Missing** | A field is *missing* when it is absent or `null`. `eq`, `in`, `exists`, `contains` and the numeric operators are false for a missing field; `neq`, `notIn` and `notExists` are their exact complements, so they are true. |
| **Limits** | at most 8 levels deep, 100 parts per rule, 50 rules per `all`/`any`, 1,000 values per list, 100 filters per graph |
| **Built-in** | `public`: `publicExposed` is `true` (a missing value is not public) · `sink`: `kind` is `rds` or `sql` (an `sqs` queue is not a sink) · `vulnerable`: at least one vulnerability. They cannot be changed or deleted. |

Examples: `{"field":"metadata.engine","op":"eq","value":"postgres"}` · `{"not":{"field":"language","op":"exists"}}` ·
`{"field":"name","op":"contains","value":"payment"}`.

`POST …/filters/preview` returns the names of the nodes a rule would match without saving anything. Creating, replacing or
deleting a filter changes query results, so it increases the graph's version. A stored rule that can no longer be compiled
(for example after a manual database edit) does not break the graph: the filter is skipped and logged, its `matchCount`
is `null`, queries that use it get `409 FILTER_UNAVAILABLE`, and a `PUT` with a valid rule repairs it.

### Route queries

```bash
GET /api/v1/graphs/{id}/routes?start=public&end=sink&through=vulnerable
```

Each of `start`, `end` and `through` takes filter keys (repeat the parameter to give several). The answer is the **subgraph of
every node and edge that lies on at least one route** that starts at a `start` node, ends at an `end` node and passes through a
`through` node.

- Several filters in one role are combined with **OR** (`start=public&start=vulnerable`); the roles must **all** hold (AND).
- A role left out puts no constraint on the route; with no role at all, the whole graph is returned.
- A start or end node counts as a through node, and a node that is both a start and an end is a route on its own.
- Routes are *walks*: a route may go round a cycle. (Restricting to simple paths would make the problem NP-hard; on a graph
  without cycles the two are identical.) Cycles and self-loops cannot make a search loop.
- No matching route is a normal `200` with empty `nodes` and `edges`.
- An unknown filter, a mistyped parameter (`?strat=public`) or a malformed key is a `400`, never a silently different answer.

```jsonc
// GET /api/v1/graphs/{id}/routes?start=public&end=sink      (a small example graph)
{
  "graphId": "…",
  "version": 1,
  "applied": { "start": ["public"], "end": ["sink"], "through": [] },
  "nodes": [
    { "name": "web", "kind": "service", "publicExposed": true,  "placeholder": false, "vulnerabilities": [], "metadata": null, "extra": null,
      "matched": { "roles": ["start"], "filters": ["public"] } },
    { "name": "api", "kind": "service", "publicExposed": false, "placeholder": false, "vulnerabilities": [ { "severity": "high", … } ], …,
      "matched": { "roles": [], "filters": [] } },
    { "name": "db",  "kind": "rds",     "publicExposed": null,  "placeholder": false, "metadata": { "engine": "postgres" }, …,
      "matched": { "roles": ["end"], "filters": ["sink"] } }
  ],
  "edges": [ { "from": "web", "to": "api" }, { "from": "api", "to": "db" } ]
}
```

`matched.roles` are the roles a node really plays (a `start` only if a route can actually go on from it), and
`matched.filters` are the filters named in the query that the node matches, so a UI can highlight entry points, sinks and
risky nodes without re-running any logic. On the sample file, no public service reaches the database, while
`through=vulnerable&end=sink` returns 21 nodes and 40 edges through `order-service` and `auth-service`.

### Versions and concurrency

Each graph has a `version` that grows with every change to its nodes, edges or filters (not with a rename). It is returned as the
`ETag`. Send it back as `If-Match` on `PUT`: if someone else changed the graph in the meantime you get `409 VERSION_CONFLICT`
and nothing is written. Replacing is atomic: either the whole new graph is stored or the old one stays untouched, and two
concurrent writers to the same graph run one after the other.

### Errors

Every error has the same shape: `{ "error": { "code", "message", "details?": [{ "path", "message" }] } }`. A request
that is wrong in several ways reports each problem with its path; a very long list is cut after 100 entries.

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` · `INVALID_JSON` · `INVALID_MULTIPART` · `INVALID_IF_MATCH` · `DUPLICATE_NODE_NAME` · `INVALID_FILTER_RULE` · `UNKNOWN_FILTER` |
| 404 | `GRAPH_NOT_FOUND` · `FILTER_NOT_FOUND` · `ROUTE_NOT_FOUND` |
| 409 | `VERSION_CONFLICT` · `FILTER_KEY_EXISTS` · `FILTER_LIMIT_REACHED` · `BUILTIN_FILTER_READ_ONLY` · `FILTER_UNAVAILABLE` |
| 413 / 415 | `PAYLOAD_TOO_LARGE` · `UNSUPPORTED_MEDIA_TYPE` |
| 500 / 503 | `INTERNAL_ERROR` (no internals are leaked) · `/health` reports a down database |

## How it works

- **PostgreSQL is the source of truth.** Graphs, nodes, edges and filters live in four tables with real constraints: composite
  foreign keys (an edge can only join two nodes of its own graph), unique names, `ON DELETE CASCADE`, and hand-written CHECK
  constraints (a placeholder holds no data, a filter key has a fixed format, …). The tests prove the database enforces them.
- **One database client.** The process has a single `PrismaClient` (one connection pool), created once by the composition root and shared by every repository and the transaction runner; it is closed on shutdown. A test fails if any other code creates one.
- **Writes are atomic.** Every change runs in one transaction whose first statement is
  `UPDATE graphs SET version = version + 1 … WHERE id = $id [AND version = $ifMatch]`: it locks the graph, checks `If-Match`
  and bumps the version in one step.
- **Queries run in memory.** The first query on a graph loads it from PostgreSQL into an immutable snapshot: nodes in a `Map`,
  adjacency lists in both directions (`Map`/`Set`), and one index per filter (`Map<filter, Set<node>>`). Later queries never touch
  the database. A write drops the snapshot only after its transaction has committed; a slow load that started before a write
  can never overwrite newer data, and at most `GRAPH_CACHE_MAX_ENTRIES` graphs (default 50) are kept, least recently used first. This is designed for a single
  server instance, where every write goes through the same process.
- **Route search** is linear in the size of the graph. With `F` = nodes reachable from the start nodes and `B` = nodes that can
  reach an end node, a node is on a route iff it is in both. A through filter adds two more searches (from the through nodes
  that `F` reaches, and back from those that `B` reaches), and a node is on a route iff `(F1 ∧ B) ∨ (F ∧ B1)`. Searches are
  iterative (a 100,000-node chain is fine). 100,000 nodes and 500,000 edges build in about 0.4 s and answer in about a
  quarter of a second.

## Tests

All tests live under `tests/`; `npm test` runs everything (about 860 tests).

- `tests/unit`: pure logic, with fake repositories where needed: configuration, error mapping, the upload parser, the graph file
  schema and normalizer, the rule validator and compiler, the graph engine, the services.
- `tests/integration`: Supertest against the real app and the real PostgreSQL from Docker Compose: every endpoint, the
  database constraints, transactions and concurrency (two writers racing for the same version), and the OpenAPI document.
  They run in a separate `test` schema of the same database, dropped and rebuilt from the real migrations at the start of every
  run, so development data is never touched. Start Postgres first: `docker compose up -d postgres`.
- The route search is checked against an **independent brute-force definition** (a product graph with a full transitive
  closure) on 4,000 random graphs with cycles, self-loops and every combination of roles.
- A test fails if the OpenAPI document and the Express routers disagree, or if the graph engine imports anything from the
  web or database layers.

## Project structure

```
src/
  server.ts        entry point: env → container → listen → graceful shutdown
  app.ts           Express app factory (no listen; used by Supertest)
  container.ts     composition root: builds repositories, services, the shared graph store, controllers
  config/          Zod-validated environment
  infrastructure/  Prisma client, transaction runner, pino logger, graceful shutdown
  http/            errors, middleware (request id, logging, validation, upload, errors), OpenAPI registry, ETag helpers
  modules/
    graphs/        upload parsing and normalization, graph service/controller/router, repository
    filters/       filter service/controller/router, repository, built-in filters, rules/ (the rule language)
    queries/       route-query parsing, service, controller; the loader that turns stored data into a snapshot
    health/        /health
    unit-of-work.ts  the repositories that share one transaction
  graph-engine/    framework-free: snapshot, filter index, conditions, route search, snapshot cache
  shared/          small cross-module types (JSON)
fixtures/          train-ticket-be.json, the sample graph
scripts/           seed script
tests/             unit and integration tests, helpers
prisma/            schema and migrations (CHECK constraints are hand-written in the migrations)
```

Request flow: `router → controller → service → repository (interface) ← Prisma implementation`. Controllers only translate
HTTP; services hold the logic and depend on repository interfaces and on a transaction runner, never on Prisma, so they are
tested with fakes. Dependencies are wired by hand in `container.ts` (no DI library).

## Decisions and assumptions

Choices the sample file and the assignment leave open, all covered by tests:

- **Sinks** are nodes of kind `rds` or `sql`; an `sqs` queue is not one. Only `publicExposed: true` is public; a missing value
  is stored as `null` and counts as not exposed.
- **Placeholders** for nodes that edges reference but the file never defines carry no invented data and never match a filter.
- **Duplicate node names** are rejected; **repeated edges** are merged; **self-loops** are allowed.
- **Unknown fields** are preserved (see above); `severity` and the other vulnerability fields are free-form because the sample
  does not say which are required. Unknown top-level and edge fields are stored too.
- **Graph names** are required but not unique; graphs are identified by UUID.
- **Walks, not simple paths**, for routes (see Route queries).
- **One server instance**: the in-memory cache is invalidated by the same process that writes.
