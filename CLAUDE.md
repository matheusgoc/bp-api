# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Serverless backend for the Bairro Promo mobile app: AWS Lambda (Node.js 22, TypeScript) · API Gateway (REST) · DynamoDB (single-table) · Cognito · CDK · SAM CLI (local dev) · Lambda Powertools · X-Ray. Bun is the package manager / script runner; Jest and the CDK CLI run on Node.

## Commands

```bash
bun install                # setup

bun run typecheck          # tsc --noEmit
bun run test               # builds handlers (esbuild), then runs Jest — handler tests + CDK assertion tests
bun run build              # esbuild bundle only, no tests
bun run watch              # esbuild --watch, rebuilds dist/ on save (for live reload against SAM local)

bun run synth              # build + cdk synth --no-staging (re-run after infra changes: routes, env vars, new functions)
bun run deploy              # build + cdk deploy
bun run destroy             # cdk destroy
bunx cdk bootstrap          # once per account/region, before first deploy

bun run local:db           # docker compose up -d — DynamoDB Local (:8000) + admin UI (:8001)
bun run local:db:down       # docker compose down
bun run local:table         # idempotent local table creation (scripts/create-local-table.mjs)
bun run local:api           # sam local start-api against cdk.out template, port 3001
```

Run a single Jest test file: `bun run build && npx jest test/handlers/health.test.ts`.

No lint/format tooling is configured (no ESLint/Prettier) — `bun run typecheck` is the only static check.

### Local dev loop

Four steps (1–2 are one-time per session):
1. `bun run local:db` — start DynamoDB Local + admin UI
2. `bun run local:table` — create the local table (idempotent)
3. `bun run synth` — synthesize the CFN template once (`--no-staging` makes it point directly at `dist/`)
4. Two terminals: `bun run watch` (rebuilds `dist/` on save) + `bun run local:api` (serves at `http://localhost:3001`, reads code fresh each request)

Re-run `bun run synth` only when infrastructure changes (routes, env vars, new Lambda functions) — handler code changes are picked up live via steps 4.

SAM local does **not** enforce the Cognito authorizer — POST/PUT/PATCH endpoints work locally without a token. In AWS a valid JWT (`Authorization: Bearer <idToken>`) is required.

## Domain model

The product domain has five entities: **place** (central), **location**, **offer**, **category**, **user**. A place has many locations, many offers, one category, and is managed by one or more users. An offer belongs to either a location or a place, never both. Users are customer (base), owner (manages their own places), admin (all places), or master (all users + places). **place** and **category** are implemented — location, offer, and user are still built out feature by feature; treat their fields (`locations`, `offers`, ownership) as placeholders until those features land.

### Place status/publish workflow

`PlaceStatus` = `draft → reviewing → active | pending`, plus `blocked` (admin-only, not settable by any current endpoint). Rules, enforced in `src/handlers/places/`:

- `add` always creates `status: draft`, `published: false`. The `category` field must reference an existing category id (`GetCommand` on `CATEGORY#<id>` before the `PutCommand`) — `400` if it doesn't exist.
- `update` (`PUT /places/{id}`) only ever touches `name`/`description`/`categoryId`/`website` and, as a side effect, always resets `status` to `reviewing` — it never touches `published`. `photo`/`logo` (upload flow) and `status`/`reason`/`published` sent in the body are silently ignored. When `categoryId` is present it must reference an existing category (same `GetCommand` check as `add`); the DTO field is `categoryId` but it's written to the item's `category` attribute (matching `PlaceItem`/`toPlaceModel`).
- `publish` only succeeds when `status === active`; nothing in the current feature set can reach `active` (that requires a future admin/review feature) — for local testing, flip an item's `status` by hand via the DynamoDB Local admin UI (`localhost:8001`).
- `unpublish` always succeeds and clears `published`/`GSI1PK` regardless of status.
- Once published, a place **stays visible** through further edit/review cycles (`draft`/`reviewing`/`pending`) — only a future `blocked` status forces it back to unpublished.
- `GET /places` (list) and `GET /places/{id}` (preview) are both public. List defaults to `published === true` places only (`?published=true`); `?published=false` (unpublished only) and `?published=all` (everything) additionally require a valid Cognito JWT, verified inside the `places-list` handler itself (see below) — preview ignores `published`/`status` entirely (no ownership model yet to restrict it further).
- A place is never deleted.

### Category

`src/handlers/categories/` implements add/update/list/preview/enable/disable/reorder. Unlike place, category has **no status/review workflow** — just a plain `enabled: boolean`, toggled directly by `enable`/`disable` (no gating condition beyond the item existing, unlike place's `publish` which requires `status === active`). `add` creates categories `enabled: true` immediately (no draft state). `update` only touches `name`/`description`; `enabled`/`order` are never accepted there. `GET /categories` (list) and `GET /categories/{id}` (preview) are both fully public for every `?enabled=` value (`true`/`false`/`all`) — no Cognito check at all, unlike `places-list`'s in-handler JWT verification, since categories are non-sensitive taxonomy data. `add`/`update`/`enable`/`disable`/`reorder` remain Cognito-protected. A category is never deleted.

Every category has a numeric `order` used to sort `GET /categories`. `add` defaults `order` to `Date.now()` so new categories sort after any hand-picked ordering without a table scan for the current max. `PATCH /categories/reorder` (body is a bare array of category ids, `string[]`) rewrites `order` to each id's index in the array (0 = first) for exactly the ids given — any category not included keeps its existing `order`. Both `GSI1SK` and `GSI2SK` store `categoryOrderSortKey(order)` (`src/models/category.ts`) — `order` zero-padded to a fixed-width string — so `list`'s `QueryCommand` sorts ascending by `order` for free via the native GSI key sort (`ScanIndexForward: true`), with no `FilterExpression`/application-side sort needed. `enable`/`disable` don't touch `order`/the SKs, only `GSI1PK`.

`scripts/seed-categories.mjs` (`bun run seed:categories`) idempotently preloads the default categories, keyed by a deterministic slug of the name (e.g. `alimentacao-e-bebidas`) rather than a random id, so re-running the script is safe (`ConditionExpression: attribute_not_exists(PK)` skips ones that already exist).

## Architecture

```
Mobile App (Expo)
      │  HTTPS + Cognito JWT
      ▼
API Gateway (REST, stage v1) ── Cognito Authorizer
      │
      ├── GET  /health                    → health Lambda            (public)
      ├── GET   /places                    → places-list Lambda       (public; ?published=false|all needs a JWT, checked in-handler)
      ├── POST  /places                    → places-add Lambda        (JWT required)
      ├── GET   /places/{id}               → places-preview Lambda    (public)
      ├── PUT   /places/{id}               → places-update Lambda     (JWT required)
      ├── PATCH /places/{id}/publish       → places-publish Lambda    (JWT required)
      ├── PATCH /places/{id}/unpublish     → places-unpublish Lambda  (JWT required)
      ├── PATCH /places/{id}/review        → places-review Lambda     (JWT required)
      ├── GET   /categories                → categories-list Lambda      (public, no auth gate)
      ├── POST  /categories                → categories-add Lambda       (JWT required)
      ├── GET   /categories/{id}           → categories-preview Lambda   (public)
      ├── PUT   /categories/{id}           → categories-update Lambda    (JWT required)
      ├── PATCH /categories/{id}/enable    → categories-enable Lambda    (JWT required)
      ├── PATCH /categories/{id}/disable   → categories-disable Lambda   (JWT required)
      └── PATCH /categories/reorder        → categories-reorder Lambda   (JWT required)
                    │
                    ▼
             DynamoDB (single-table: PK/SK + GSI1 + GSI2)
```

- **Infra as code**: everything is defined in `lib/bp-api-stack.ts` (CDK, synthesized to CloudFormation) and instantiated from `bin/bp-api.ts`. This is the single source of truth for routes, auth, table schema, and Lambda config — always check it before assuming behavior from handler code alone.
- **Lambda factory**: `makeFunction()` in `bp-api-stack.ts` applies shared defaults to every function — Node 22 / ARM64, 256MB/10s, X-Ray tracing active, a dedicated CloudWatch log group (1-week retention), and standard Powertools env vars (`POWERTOOLS_SERVICE_NAME`, `POWERTOOLS_METRICS_NAMESPACE`, etc). New Lambdas should go through this factory rather than being constructed ad hoc.
- **Bundling**: each handler is bundled independently by `scripts/build.mjs` (esbuild) into `dist/<name>/index.js`, matched 1:1 with `Code.fromAsset('dist/<name>')` in the stack. The AWS SDK v3 is excluded from the bundle (`external: ['@aws-sdk/*']`) since it ships with the Node.js Lambda runtime.
- **DynamoDB single-table design**: one table, `PK`/`SK` for entity access, `GSI1` (`GSI1PK`/`GSI1SK`) for the public listing, `GSI2` (`GSI2PK`/`GSI2SK`) for the unrestricted/admin listing. Places are stored as `PK=PLACE#<id>, SK=METADATA`. `GSI1PK` is a **sparse index attribute** — it's only present (`'PLACE#PUBLISHED'`) while `published === true`; `publish`/`unpublish` add/remove it via `UpdateExpression`. This makes the default `GET /places` (`?published=true`) a plain `QueryCommand` on `GSI1PK = 'PLACE#PUBLISHED'` with no `FilterExpression`, and it's naturally empty until something is published. `GSI2PK` is always `'PLACE'` (set once at creation, never changes) — `?published=all` queries it with no filter, `?published=false` queries it with a `FilterExpression published = :false`. `places-list` paginates with DynamoDB's native cursor mechanism — `?take` (default 20, capped 100) maps to `Limit`, `?cursor` is an opaque base64url token wrapping `LastEvaluatedKey` (tagged with the filter it was issued for, so a cursor can't be replayed against a different index/filter) — so each request reads only `take` items regardless of table size. There is deliberately no `page`/`itemCount`/`pageCount` in the response: DynamoDB has no random access into an index and no cheap total count, so an offset-style contract would force either an unbounded scan or a separately maintained counter — cursor pagination (`meta.nextCursor`/`hasNextPage`/`hasPreviousPage`) is the query cost DynamoDB actually gives you for free. Use the sparse-GSI1 pattern for any future entity that needs a "visible/filtered" listing view; use the plain always-present-GSI-PK pattern (`GSIxPK=<TYPE>, GSIxSK=createdAt`) for simple newest-first listings with no visibility gate. **category** reuses this exact pattern in the same table (`PK=CATEGORY#<id>`, `GSI1PK='CATEGORY#ENABLED'` sparse on `enabled`, `GSI2PK='CATEGORY'` always) — no schema change was needed, since GSI1/GSI2 are generic string attributes shared across entity types. Category deviates from the `GSIxSK=createdAt` convention above: both `GSI1SK`/`GSI2SK` hold a zero-padded encoding of its `order` field instead, so listing sorts by manually-curated `order` rather than newest-first (see Category section). The table shape is defined by hand in two places — `lib/bp-api-stack.ts` (deployed) and `scripts/create-local-table.mjs` (local dev) — there's no shared source or migration framework, so schema changes must be applied to both (sparse-index behavior itself needs no schema change, since GSI PK/SK are already generic string attributes; adding a *new* GSI like GSI2 does need both files updated, as done here).
- **Models** (`src/models/`): one file per entity (e.g. `place.ts`), each exporting a `<Entity>Status` enum (if applicable), a client-facing `<Entity>Model` type, an internal `<Entity>Item` type (DynamoDB shape), and a `to<Entity>Model()` mapper. Handlers convert DynamoDB items to API responses through the mapper rather than building response objects by hand.
- **Shared handler libs** (`src/lib/`):
  - `dynamo.ts` — exports a shared `ddb` (DynamoDBDocumentClient) and `TABLE_NAME`. Switches to a local endpoint automatically when `DYNAMODB_ENDPOINT` is set (SAM local / `env.json`); otherwise talks to real AWS DynamoDB. X-Ray capture is wired in here.
  - `http.ts` — response helpers (`json`, `badRequest`, `unauthorized`, `notFound`, `serverError`); all handlers should return through these rather than building `APIGatewayProxyResult` by hand.
  - `powertools.ts` — single shared `logger` / `tracer` / `metrics` instances (module-scoped so they're reused across warm Lambda invocations). Always call `logger.addContext(context)` at the top of a handler.
- **Env config**: `env.json` supplies local-only overrides (`DYNAMODB_ENDPOINT`, debug log level, tracing disabled) consumed by `sam local start-api`; in real AWS these come from the CDK stack's Lambda environment instead.
- **Auth**: Cognito user pool + client defined in the stack; API Gateway's `CognitoUserPoolsAuthorizer` gates specific methods via the `requireAuth` `MethodOptions`. In protected handlers, the caller's identity is read from `event.requestContext.authorizer?.claims?.sub` (falls back to `'local-dev'` when running under SAM local, since the authorizer isn't enforced there). There's no role/ownership enforcement yet — any authenticated user can mutate any place; that's deferred to the future User/role feature.
  - `GET /places` is the one route with **conditional** auth: the method itself has no Gateway authorizer (a REST API method's authorizer is all-or-nothing, and the default `?published=true` listing must stay public), so `places-list` verifies the `Authorization: Bearer <idToken>` header itself with `aws-jwt-verify`'s `CognitoJwtVerifier` (against `USER_POOL_ID`/`USER_POOL_CLIENT_ID`, passed to that function only) whenever `?published=false|all` is requested, returning 401 if it's missing or invalid. Under SAM local this check is skipped entirely (`isLocal = !!process.env.DYNAMODB_ENDPOINT` short-circuits `requireAuthenticated` to `true`), so `?published=false|all` works locally with no token and the handler never reaches out to a real Cognito user pool — consistent with the `local-dev` fallback used by other protected endpoints.

### Adding a new endpoint

1. Create `src/handlers/<entity>/<name>.ts` (e.g. `src/handlers/places/add.ts`), and a `src/models/<entity>.ts` if it's a new entity.
2. Add an entry to `entries` in `scripts/build.mjs` — the key becomes the `dist/<name>` folder used by `Code.fromAsset`.
3. Wire the Lambda (via `makeFunction`) and the API Gateway route/method in `lib/bp-api-stack.ts`, granting the minimum required DynamoDB permissions (`grantReadData` / `grantWriteData`).
4. Run `bun run synth` to regenerate the CloudFormation template.

### Testing

- `test/handlers/*.test.ts` — unit tests that import the handler directly and invoke it with a mock event/context.
- `test/bp-api-stack.test.ts` — CDK assertion tests against the synthesized template (`Template.fromStack`); verifies table schema, Cognito resources, Lambda tracing config, and authorizer wiring. This file requires `dist/` to exist first (handled by the `pretest`-equivalent `bun run build && jest` in the `test` script) since `Code.fromAsset` reads from disk.
- Jest config restricts `roots` to `test/`, matching `**/*.test.ts`, with `clearMocks: true`.
