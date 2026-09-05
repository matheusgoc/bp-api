# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Serverless backend for the Bairro Promo mobile app: AWS Lambda (Node.js 22, TypeScript) · API Gateway (REST) · DynamoDB (single-table) · Cognito · CDK · SAM CLI (local dev) · Lambda Powertools · X-Ray. Bun is the package manager / script runner; Jest and the CDK CLI run on Node.

## Verification scope

Keep post-implementation verification minimal: `bun run typecheck` + the relevant `bun run test` is enough. Don't run extended end-to-end smoke tests, multi-step manual API walkthroughs (curl chains against local SAM/DynamoDB/MinIO), or exploratory debugging loops against local infra unless explicitly asked — the user prefers to do that verification themselves and finds long automated verification passes slow.

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

bun run local:storage           # docker compose up -d — DynamoDB Local (:8000) + admin UI (:8001) + MinIO (:9000, console :9001)
bun run local:storage:down       # docker compose down
bun run local:storage:reset      # docker volume rm bp-api_dynamodb-data bp-api_minio-data — wipes all local data (run after local:storage:down; then local:storage + local:table + local:bucket to recreate empty)
bun run local:table         # idempotent local table creation (scripts/create-local-table.mjs)
bun run local:bucket        # idempotent local MinIO bucket bootstrap (scripts/create-local-bucket.mjs)
bun run local:api           # sam local start-api against cdk.out template, port 3001
```

Run a single Jest test file: `bun run build && npx jest test/handlers/health.test.ts`.

No lint/format tooling is configured (no ESLint/Prettier) — `bun run typecheck` is the only static check.

### Local dev loop

Five steps (1–3 are one-time per session):
1. `bun run local:storage` — start DynamoDB Local + admin UI + MinIO (S3-compatible local storage)
2. `bun run local:table` — create the local table (idempotent)
3. `bun run local:bucket` — create the local bucket (idempotent)
4. `bun run synth` — synthesize the CFN template once (`--no-staging` makes it point directly at `dist/`)
5. Two terminals: `bun run watch` (rebuilds `dist/` on save) + `bun run local:api` (serves at `http://localhost:3001`, reads code fresh each request)

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
- `PATCH /places/{id}/images/{type}` (`{type}` is `photo` or `logo`, uploaded separately — one call per type) issues a short-lived (5-minute) presigned S3 PUT URL so the Expo app can upload the file directly to S3, and writes the resulting URL to `draftPhoto`/`draftLogo` immediately — optimistic, before the client's S3 PUT actually completes, but the public `photo`/`logo` field is never touched by this endpoint. Doesn't touch `status`/`published`. Object key is a *draft* key (`places/{id}/{type}-draft.{ext}`, `ext` derived from the required `contentType` in the body) — distinct from the live key, so re-uploading a photo can never silently overwrite the bytes an already-approved, publicly-visible `photo`/`logo` URL points at.
- `PATCH /places/{id}/images/{type}/approve` (`src/handlers/places/approveImage.ts`) promotes a pending draft to live: reads `draftPhoto`/`draftLogo` (`400` if empty/absent — nothing to approve), copies the S3 object from its draft key to its live key (`places/{id}/{type}.{ext}`) via `CopyObjectCommand`, then `SET`s `photo`/`logo` to the live URL and clears the draft field back to `''` in one `UpdateCommand`, and best-effort deletes the now-orphaned draft object. This is the intended hook point for future image verification/moderation/manipulation — for now it does nothing but the move. `draftPhoto`/`draftLogo` exist only on `PlaceItem` (the internal DynamoDB shape), never on `PlaceModel`/`toPlaceModel()` — `GET /places` and `GET /places/{id}` are public, so exposing unmoderated draft URLs there would defeat the point.
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
      ├── PATCH /places/{id}/images/{type} → places-upload-image Lambda (JWT required)
      ├── PATCH /places/{id}/images/{type}/approve → places-approve-image Lambda (JWT required)
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
- **Bundling**: each handler is bundled independently by `scripts/build.mjs` (esbuild) into `dist/<name>/index.js`, matched 1:1 with `Code.fromAsset('dist/<name>')` in the stack. Only the DynamoDB-family AWS SDK v3 packages are excluded from the bundle (`external: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb']`), since only those are confirmed present in the Node.js 22 managed Lambda runtime — every other `@aws-sdk/*` package (e.g. `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, used by `places-upload-image`) is bundled in rather than excluded, since the runtime doesn't ship them and a wildcard exclude would fail at cold start with `Cannot find module`.
- **DynamoDB single-table design**: one table, `PK`/`SK` for entity access, `GSI1` (`GSI1PK`/`GSI1SK`) for the public listing, `GSI2` (`GSI2PK`/`GSI2SK`) for the unrestricted/admin listing. Places are stored as `PK=PLACE#<id>, SK=METADATA`. `GSI1PK` is a **sparse index attribute** — it's only present (`'PLACE#PUBLISHED'`) while `published === true`; `publish`/`unpublish` add/remove it via `UpdateExpression`. This makes the default `GET /places` (`?published=true`) a plain `QueryCommand` on `GSI1PK = 'PLACE#PUBLISHED'` with no `FilterExpression`, and it's naturally empty until something is published. `GSI2PK` is always `'PLACE'` (set once at creation, never changes) — `?published=all` queries it with no filter, `?published=false` queries it with a `FilterExpression published = :false`. `places-list` paginates with DynamoDB's native cursor mechanism — `?take` (default 20, capped 100) maps to `Limit`, `?cursor` is an opaque base64url token wrapping `LastEvaluatedKey` (tagged with the filter it was issued for, so a cursor can't be replayed against a different index/filter) — so each request reads only `take` items regardless of table size. There is deliberately no `page`/`itemCount`/`pageCount` in the response: DynamoDB has no random access into an index and no cheap total count, so an offset-style contract would force either an unbounded scan or a separately maintained counter — cursor pagination (`meta.nextCursor`/`hasNextPage`/`hasPreviousPage`) is the query cost DynamoDB actually gives you for free. Use the sparse-GSI1 pattern for any future entity that needs a "visible/filtered" listing view; use the plain always-present-GSI-PK pattern (`GSIxPK=<TYPE>, GSIxSK=createdAt`) for simple newest-first listings with no visibility gate. **category** reuses this exact pattern in the same table (`PK=CATEGORY#<id>`, `GSI1PK='CATEGORY#ENABLED'` sparse on `enabled`, `GSI2PK='CATEGORY'` always) — no schema change was needed, since GSI1/GSI2 are generic string attributes shared across entity types. Category deviates from the `GSIxSK=createdAt` convention above: both `GSI1SK`/`GSI2SK` hold a zero-padded encoding of its `order` field instead, so listing sorts by manually-curated `order` rather than newest-first (see Category section). The table shape is defined by hand in two places — `lib/bp-api-stack.ts` (deployed) and `scripts/create-local-table.mjs` (local dev) — there's no shared source or migration framework, so schema changes must be applied to both (sparse-index behavior itself needs no schema change, since GSI PK/SK are already generic string attributes; adding a *new* GSI like GSI2 does need both files updated, as done here).
- **Models** (`src/models/`): one file per entity (e.g. `place.ts`), each exporting a `<Entity>Status` enum (if applicable), a client-facing `<Entity>Model` type, an internal `<Entity>Item` type (DynamoDB shape), and a `to<Entity>Model()` mapper. Handlers convert DynamoDB items to API responses through the mapper rather than building response objects by hand.
- **Shared handler libs** (`src/lib/`):
  - `dynamo.ts` — exports a shared `ddb` (DynamoDBDocumentClient) and `TABLE_NAME`. Switches to a local endpoint automatically when `DYNAMODB_ENDPOINT` is set (SAM local / `env.json`); otherwise talks to real AWS DynamoDB. X-Ray capture is wired in here.
  - `s3.ts` — exports **two** S3 clients plus `BUCKET_NAME`/`PUBLIC_URL_BASE`, because local dev has two different notions of "the S3 endpoint": `s3` is for calls the Lambda itself makes over the network (`CopyObjectCommand`/`DeleteObjectCommand` in `approveImage.ts`) — like `DYNAMODB_ENDPOINT`, this must be resolvable *inside* the docker network, so locally `S3_ENDPOINT=http://minio:9000`. `s3Presign` is used only for `getSignedUrl()` (in `uploadImage.ts`) — since presigned-URL generation is offline SigV4 signing with no actual network call, and the resulting URL is handed to an *external* caller (the Expo app / curl / Bruno) outside the docker network, this one needs `S3_PRESIGN_ENDPOINT=http://localhost:9000` instead. Getting these two mixed up either breaks presigned uploads (client gets a URL it can't resolve) or breaks the approve endpoint (`ECONNREFUSED` from inside the Lambda container trying to reach `localhost`). In real AWS neither env var is set, so both clients resolve to the same real S3 endpoint — this split only matters locally.
  - `http.ts` — response helpers (`json`, `badRequest`, `unauthorized`, `notFound`, `serverError`); all handlers should return through these rather than building `APIGatewayProxyResult` by hand.
  - `powertools.ts` — single shared `logger` / `tracer` / `metrics` instances (module-scoped so they're reused across warm Lambda invocations). Always call `logger.addContext(context)` at the top of a handler.
- **Env config**: `env.json` supplies local-only overrides (`DYNAMODB_ENDPOINT`, `BUCKET_NAME`/`S3_ENDPOINT`/`S3_PRESIGN_ENDPOINT`/`S3_PUBLIC_URL_BASE`, debug log level, tracing disabled) consumed by `sam local start-api`; in real AWS these come from the CDK stack's Lambda environment instead.
- **Auth**: Cognito user pool + client defined in the stack; API Gateway's `CognitoUserPoolsAuthorizer` gates specific methods via the `requireAuth` `MethodOptions`. In protected handlers, the caller's identity is read from `event.requestContext.authorizer?.claims?.sub` (falls back to `'local-dev'` when running under SAM local, since the authorizer isn't enforced there). There's no role/ownership enforcement yet — any authenticated user can mutate any place; that's deferred to the future User/role feature.
  - `GET /places` is the one route with **conditional** auth: the method itself has no Gateway authorizer (a REST API method's authorizer is all-or-nothing, and the default `?published=true` listing must stay public), so `places-list` verifies the `Authorization: Bearer <idToken>` header itself with `aws-jwt-verify`'s `CognitoJwtVerifier` (against `USER_POOL_ID`/`USER_POOL_CLIENT_ID`, passed to that function only) whenever `?published=false|all` is requested, returning 401 if it's missing or invalid. Under SAM local this check is skipped entirely (`isLocal = !!process.env.DYNAMODB_ENDPOINT` short-circuits `requireAuthenticated` to `true`), so `?published=false|all` works locally with no token and the handler never reaches out to a real Cognito user pool — consistent with the `local-dev` fallback used by other protected endpoints.

### Adding a new endpoint

1. Create `src/handlers/<entity>/<name>.ts` (e.g. `src/handlers/places/add.ts`), and a `src/models/<entity>.ts` if it's a new entity.
2. Add an entry to `entries` in `scripts/build.mjs` — the key becomes the `dist/<name>` folder used by `Code.fromAsset`.
3. Wire the Lambda (via `makeFunction`) and the API Gateway route/method in `lib/bp-api-stack.ts`, granting the minimum required DynamoDB permissions (`grantReadData` / `grantWriteData`). Non-DynamoDB infra (e.g. the images S3 bucket) isn't covered by those calls — grant the minimum bucket-level action directly instead (e.g. `bucket.grantPut(fn)`), and pass any extra config via `.addEnvironment(...)`.
4. Run `bun run synth` to regenerate the CloudFormation template.

### Testing

- `test/handlers/*.test.ts` — unit tests that import the handler directly and invoke it with a mock event/context. `getSignedUrl` (`@aws-sdk/s3-request-presigner`) doesn't call `client.send()` — it reads client config directly — so `aws-sdk-client-mock`'s `mockClient()` can't intercept it; tests needing a presigned URL use `jest.mock('@aws-sdk/s3-request-presigner')` instead (see `test/handlers/places/uploadImage.test.ts`), while DynamoDB calls in the same handler are still mocked the normal `mockClient(ddb)` way.
- `test/bp-api-stack.test.ts` — CDK assertion tests against the synthesized template (`Template.fromStack`); verifies table schema, Cognito resources, Lambda tracing config, and authorizer wiring. This file requires `dist/` to exist first (handled by the `pretest`-equivalent `bun run build && jest` in the `test` script) since `Code.fromAsset` reads from disk.
- Jest config restricts `roots` to `test/`, matching `**/*.test.ts`, with `clearMocks: true`.
