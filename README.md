# Graph Analysis Platform — Backend

Backend for the Backslash Security home assignment. Users upload JSON files that describe a
microservice architecture as a directed graph (nodes, edges, vulnerabilities) and query the routes
between services with dynamic filters, such as public entry points, database sinks and vulnerable nodes.

**Stack:** Node.js · TypeScript · Express 5 · PostgreSQL · Prisma 7 · Zod · OpenAPI/Swagger · pino · Jest · Supertest · Docker Compose

> Status: Tasks 1-3 of 5 done (foundation, data layer, graph upload and CRUD). Filters, route queries and the graph engine arrive in the following tasks.

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

Everything is validated with Zod at startup, and the server refuses to start with a list of every invalid variable.
If the password contains URL-special characters, URL-encode it inside `DATABASE_URL`.

## Running

```bash
npm install

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

The backend container runs `prisma migrate deploy` before starting, and it waits until the Postgres healthcheck passes.

## Scripts

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

## Tests

All tests live under `tests/`:

- `tests/unit` covers pure logic (config, error mapping, validation, services with fake repositories).
- `tests/integration` covers Supertest API tests and database tests against the Postgres from Docker Compose.
  They run in a separate `test` schema of the same database, which is dropped and rebuilt from the real
  migrations at the start of every run, so development data is never touched. Start Postgres first:
  `docker compose up -d postgres`.

## API overview

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness plus a database check (`200` / `503`) |
| GET | `/docs`, `/docs/openapi.json` | Swagger UI and the OpenAPI document |
| POST | `/api/v1/graphs` | Create a graph from an uploaded JSON file (`multipart/form-data`: `file`, `name`) |
| GET | `/api/v1/graphs` | List graph summaries (newest first) |
| GET | `/api/v1/graphs/:id` | The graph with its nodes and edges; `ETag` holds the version |
| PUT | `/api/v1/graphs/:id` | Atomically replace nodes and edges from a new file (`file`, optional `name`, optional `If-Match`) |
| PATCH | `/api/v1/graphs/:id` | Rename (`{"name": "..."}`); the version is unchanged |
| DELETE | `/api/v1/graphs/:id` | Delete the graph with its nodes, edges and filters |
| GET / POST / PUT / DELETE | `/api/v1/graphs/:id/filters[/:key]`, `POST …/filters/preview` | Task 5 |
| GET | `/api/v1/graphs/:id/routes?start=&end=&through=` | Task 5 |

Errors always use the format `{ "error": { "code", "message", "details?" } }`.

### Uploading a graph

```bash
curl -F "name=Train Ticket" -F "file=@fixtures/train-ticket-be.json" http://localhost:3000/api/v1/graphs
```

- Only JSON is accepted: the file must be named `*.json` or be sent as `application/json` (otherwise `415`).
- The content is always validated, whatever the file name or content type claims: it must be UTF-8 JSON of the right shape (`400 INVALID_JSON` / `400 VALIDATION_ERROR` with the exact field paths).
- Nodes need a `name` and a `kind`. `language`, `path`, `publicExposed`, `vulnerabilities` and `metadata` are optional and type-checked when present.
- **Unknown fields are preserved at every level**, never validated and never dropped: on the file itself (returned as `extra` of the graph), on each node (`extra` of the node), on each edge (`extra` of the edge, left out when there is none) and inside vulnerabilities and `metadata` objects, which are kept whole.
  - An edge entry's unknown fields are copied onto every edge it expands to; when the same edge appears twice, their unknown fields are merged (later entry wins on a conflicting key).
  - Replacing a graph replaces these fields too. Values are stored exactly; only the order of keys inside an object is not kept (PostgreSQL `jsonb` orders them itself).
  - The one exception: an object key named `__proto__` (at any depth) is refused with `400`, because Prisma would silently drop it and we would rather fail loudly than lose data. Other special names (`constructor`, `prototype`, `toString`, an empty key, ...) are stored normally.
- An edge's `to` may be a string or an array. Edges are split into pairs, repeated edges are merged, self-loops are kept.
- Nodes that edges reference but the file does not define become **placeholder nodes** (name only). The response lists them in `placeholders`.
- Duplicate node names are rejected (`400 DUPLICATE_NODE_NAME`). Limits come from `.env` (`MAX_UPLOAD_BYTES` -> `413`, `MAX_NODES`, `MAX_EDGES` -> `413`).
- Graph names are required but need not be unique.
- Every new graph gets three read-only built-in filters: `public`, `sink` (kind `rds` or `sql`) and `vulnerable`.

### Concurrency

Each graph has a `version` that grows with every change to its nodes, edges or filters. It is returned as the `ETag`.
Send it back as `If-Match` on `PUT`: if someone else changed the graph in the meantime you get `409 VERSION_CONFLICT`
and nothing is written. Replacing is atomic: either the whole new graph is stored or the old one stays untouched.

## Project structure

```
src/
  server.ts        entry point: env → container → listen → graceful shutdown
  app.ts           Express app factory (no listen; used by Supertest)
  container.ts     composition root (manual dependency injection)
  config/          Zod-validated environment
  infrastructure/  Prisma client, pino logger, graceful shutdown
  http/            errors, middleware, OpenAPI registry and docs router
  modules/         feature modules: router → controller → service → repository
                   (graphs/ is complete; filters/ so far holds repositories and the built-in filters;
                   unit-of-work.ts groups the repositories that share one transaction)
  shared/          small cross-module types (JSON)
  graph-engine/    framework-free graph model and route engine (Task 4)
fixtures/         train-ticket-be.json, the sample graph
scripts/          seed script
tests/             unit and integration tests
prisma/            schema and migrations (CHECK constraints are hand-written in the init migration)
```
