# Bairro Promo API

Serverless backend to server the [Bairro Promo](https://github.com/matheusgoc/bairropromo) mobile app. It runs on top of AWS Serverless Lambda functions service and DynamoDB NoSQL database for data persistence. There is a docker container to run to emulate the local environment as well as the DynamoDB database. 

**Stack:** AWS Lambda (Node.js 22, TypeScript) · API Gateway (REST) · DynamoDB (single-table) · Cognito · CDK · SAM CLI (local dev) · Lambda Powertools · X-Ray · Bun (package manager / script runner)

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (package manager + runs the CDK app's TypeScript directly)
- Node.js ≥ 20 (Jest and the CDK CLI run on Node)
- Docker Desktop
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS CLI configured (`aws configure`) — only needed for deploying

## Setup

Install dependencieys first:

```bash
bun install
```

### CLIs

Some command lines interface are required to run and the deploy the application. 

#### CDK CLI

The CDK CLI is a project dev dependency, so it's available without a global install via 

`bunx cdk <command>` or `bun run cdk -- <command>`

You may also install `cdk` on your global path for convinience:

```bash
# install 
$ bun install -g aws-cdk

# verify
$ cdk --version 
```

#### SAM CLI

SAM CLI is a separate AWS tool (Python-based, not an npm package). 

On macOS:

```bash
# install
$ brew install aws-sam-cli

# verify
$ sam --version
```

No Homebrew? AWS also publishes a standalone `.pkg` installer — see the [SAM CLI install docs](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).

## Run

### 6 steps

*Steps 1 through 3 are one-time per session!*

1. Start local DynamoDB (+ admin UI at http://localhost:8001) and MinIO (S3-compatible local storage, console at http://localhost:9001)

      ```bash
      $ bun local:storage
      ```

      same as `docker compose up -d`

2. Create the local table (idempotent)

      ```bash
      $ bun local:table
      ```

      same as `node scripts/create-local-table.mjs`

3. Create the local bucket (idempotent)

      ```bash
      $ bun local:bucket
      ```

      same as `node scripts/create-local-bucket.mjs`

4. Synthesize the CloudFormation template once

      ```bash
      $ bun synth
      ````

      same as `bun run build && cdk synth --no-staging`

5. Live Reload - rebuild handlers on every save (Terminal A):

      ```bash
      $ bun watch
      ```

      same as `node scripts/build.mjs --watch`

6. Serve the API at http://localhost:3001 (Terminal B)

      ```bash
      $ bun local:api
      ```
      
      same as 
      
      `sam local start-api -t cdk.out/BpApiStack.template.json --docker-network bp-api --env-vars env.json --port 3001`

      Or run steps 5 and 6 together in one terminal:

      ```bash
      $ bun start
      ```

      same as `bun run watch & bun run local:api; wait` — backgrounds the esbuild watcher, runs SAM local in the foreground, and `Ctrl+C` stops both.

Live reload works because `cdk synth --no-staging` makes the template point at `dist/` directly, and SAM local reads the code fresh on each request — so `bun run watch` rebuilds and the next request runs your new code. Re-run `bun run synth` only when you change **infrastructure** (routes, env vars, new functions).

SAM local **does not enforce** the Cognito authorizer, so POST/PUT/PATCH work locally without a token. In AWS they require a valid JWT (`Authorization: Bearer <idToken>`).

> [!NOTE]
`sam local start-api` on **step 6** needs a **valid AWS SSO session**, even though it only serves local requests. The synthesized template always includes a `BootstrapVersion` parameter (`AWS::SSM::Parameter::Value<String>`, added automatically by CDK for the real `cdk deploy` bootstrap check), and SAM resolves every template parameter — including that one — against real AWS when it loads the template, regardless of whether anything local actually uses it. If step 6 fails with something like `TokenRetrievalError: Error when retrieving token from sso`, refresh your session and retry:
> ```bash
> aws sso login  # or: aws sso login --sso-session <your-sso-session-name>
> ```

### Try

```bash
curl http://localhost:3001/health
```

## Database

Data persistence is based on AWS DynamoDB NoSQL database. You can access it through AWS Console on production and DynamoDB UI Admin locally. There is also a seeder to populates categories. See below for more information:

### Data Access

**Local**: `docker compose up -d` (step 1) also starts [dynamodb-admin](https://github.com/aaronshaf/dynamodb-admin) at http://localhost:8001 — a browser UI to view/edit/delete items and run queries against DynamoDB Local.

**Production (AWS)**: there's no hosted admin UI. 
Access DynamoDB on the AWS Console directly at 

`DynamoDB → Tables → your table → Explore table items`

### Seed

Populate the default categories (idempotent — safe to re-run):

```bash
# local
bun run local:seed:categories

# production
bun run seed:categories
```

> [!NOTE]
Requires the table to already exist. It targets local DynamoDB by default.

To seed a deployed stack (staging | production) instead, leave `DYNAMODB_ENDPOINT` unset (so the AWS SDK talks to real DynamoDB using your normal AWS credentials/region) and pass the deployed table name — from the `TableName` CDK output, or `bunx cdk deploy` output, or `aws cloudformation describe-stacks --stack-name BpApiStack --query "Stacks[0].Outputs"`:

```bash
TABLE_NAME=<deployed-table-name> AWS_PROFILE=<profile> bun run seed:categories
```

Your AWS credentials need `dynamodb:PutItem` on that table.

## Images (S3)

File uploads (place `photo`/`logo`, and any future upload location) follow a **presign → upload → approve** flow, going straight from the mobile app to S3 rather than through Lambda:

1. **Presign** — an endpoint like `PATCH /places/{id}/images/{type}` returns a short-lived presigned PUT URL for a *draft* key.
2. **Upload** — the app PUTs the file bytes directly to that URL (e.g. with `expo-file-system`'s `uploadAsync`); the draft URL is recorded on the entity (`draftPhoto`/`draftLogo`) and returned in place responses, so the app's owner/admin place management view can show the pending image.
3. **Approve** — an endpoint like `PATCH /places/{id}/images/{type}/approve` copies the object server-side from its draft key to a live key and only then clears the draft. Draft and live keys are versioned (`places/{id}/{type}-draft-{version}.{ext}`, `places/{id}/{type}-{version}.{ext}`), so every upload and every approval gets a new URL — clients and caches never keep showing an old image — and the object each one replaces is deleted. This is the hook point for future image verification/moderation before an image becomes the place's public `photo`/`logo`.

**Local**: MinIO (S3-compatible) runs via `docker compose up -d`, bucket created by `bun local:bucket`. Two env vars point at it for different reasons — `S3_ENDPOINT` (server-side calls like approve) must resolve inside the docker network (`http://minio:9000`); `S3_PRESIGN_ENDPOINT` (baked into presigned URLs) must resolve from the host (`http://localhost:9000`).

**Production (AWS)**: the bucket is provisioned by CDK with CORS enabled and public read on the `places/*` prefix — every place image, live and draft. The public `photo`/`logo` fields only change on approve, but a draft is fetchable by its URL before that.

## Test

```bash
# tsc --noEmit
bun run typecheck   

# builds handlers, then runs Jest (handler + CDK assertion tests)
bun run test        
```

## Deploy

```bash
# once per account/region
bunx cdk bootstrap
bun run deploy
```

Outputs include `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `TableName`, and `ImagesBucketName` — the first three go into the mobile app's config (e.g., Amplify/amazon-cognito-identity-js).

## Architecture

```
Mobile App (Expo)
      │  HTTPS + Cognito JWT
      ▼
API Gateway (REST, stage v1) ── Cognito Authorizer
      │
      ├── endpoints...
                    │
                    ▼
             DynamoDB (single-table: PK/SK + GSI1 + GSI2)
```

Infrastructure is defined in TypeScript with **CDK** (`lib/bp-api-stack.ts`), which synthesizes CloudFormation. Locally, **SAM CLI** runs the synthesized template in Docker containers against **DynamoDB Local**.

- Every Lambda has **X-Ray tracing**, a dedicated **CloudWatch log group** (1-week retention), and **Lambda Powertools** (structured logs, tracer, metrics).
- Handlers are bundled per-function with **esbuild** into `dist/<name>/index.js`. Only the DynamoDB-family AWS SDK v3 packages are excluded from the bundle (they ship with the runtime) — other `@aws-sdk/*` packages, like the S3 client/presigner used for image uploads, are bundled in.
- Place `photo`/`logo` uploads go directly to an **S3 bucket** via a presigned PUT URL (`PATCH /places/{id}/images/{type}`) — see [Images (S3)](#images-s3).
- DynamoDB uses single-table design: places are `PK=PLACE#<id>, SK=METADATA`. `GSI1PK` is **sparse** — it's only set to `PLACE#PUBLISHED` while a place is published, so `GET /places` is a plain query against `GSI1` with no filter expression, and naturally excludes drafts/unpublished places. `GSI2PK` is always `'PLACE'` (set once at creation) and backs the unrestricted `?published=all`/`?published=false` listing views. **category** reuses the exact same pattern (`PK=CATEGORY#<id>`, `GSI1PK='CATEGORY#ENABLED'` sparse on `enabled`, `GSI2PK='CATEGORY'` always) in the same table — no schema change was needed. **Locations** live in their place's partition (`PK=PLACE#<placeId>, SK=LOCATION#<id>`, no GSI attributes), so `GET /places/{id}` fetches a place and all its locations with a single query. **Offers** are their own items (`PK=OFFER#<id>, SK=METADATA`) — kept out of the place partition since they're never deleted and would pile up there — reached through the same two index patterns: a sparse `GSI1PK=OFFER#ACTIVE#PLACE#<placeId>` (only while active, `GSI1SK` = the offer's end) that the previews query for live offers, and an always-present `GSI2PK=OFFER#PLACE#<placeId>` (`GSI2SK=createdAt`) behind the paginated offers list.
- The domain model is **place** (central), **location**, **offer**, **category**, **user** — a place has many locations and offers, one category, and one or more owning users. An offer always belongs to a place and optionally to one of its locations. All five are implemented.

## Endpoints

JWT-required routes expect `Authorization: Bearer <idToken>` (Cognito), enforced by API Gateway's Cognito authorizer in AWS. (**SAM local does not enforce it** — those routes work locally without a token.)

The "owner/admin" routes additionally look up the caller's profile and return `403` unless its `role` is `owner` or `admin`. The "place owner/admin" routes go one step further: an owner must also be one of the place's owners (its internal `ownerBy` list, set to the creator by `POST /places` and extended by `PATCH /places/{id}/grant`) — `403` otherwise, `404` if the place doesn't exist. Admins can manage every place. Locations and offers follow their place's ownership. The "admin" routes accept admins only.

### Health

| Method | Path      | Auth   | Description |
|--------|-----------|--------|-------------|
| GET    | `/health` | Public | Health check. |

### Profile

| Method | Path               | Auth         | Description |
|--------|--------------------|--------------|-------------|
| POST   | `/profile`         | JWT required | Create the caller's app-level profile — called by the app after Amplify Cognito signup/confirm/signin. Requires `name`/`email`; `phone`/`isWhatsapp`/`dob`/`gender` optional. Created as `role: customer`, `subscriptionStatus: not_applied`. `409` if the caller already has a profile. |
| GET    | `/profile`         | JWT required | Preview the caller's own profile (resolved from the token, never a path parameter). |
| PUT    | `/profile`         | JWT required | Update the caller's own `name`/`email`/`phone`/`dob`/`gender`/`isWhatsapp`. |
| PATCH  | `/profile/convert` | JWT required | Convert the caller to `owner` (no body needed). If the caller is an `admin` and the body has `{ id, type? }`, converts that *other* user instead to `type` (any role, default `owner`) — `400` if `id` is the caller's own, `404` if the user doesn't exist. Non-admins' `id`/`type` are ignored. |

### Categories

| Method | Path                       | Auth         | Description |
|--------|----------------------------|--------------|-------------|
| GET    | `/categories`              | Public       | List categories. `?enabled=` (`true`/`false`/`all`) |
| POST   | `/categories`              | JWT required | Create a category. Always created `enabled: true` (no draft state). |
| GET    | `/categories/{id}`         | Public       | Preview a single category. |
| PUT    | `/categories/{id}`         | JWT required | Update `name`/`description` only. |
| PATCH  | `/categories/{id}/enable`  | JWT required | Set `enabled: true`. |
| PATCH  | `/categories/{id}/disable` | JWT required | Set `enabled: false`. |
| PATCH  | `/categories/reorder`      | JWT required | Rewrite `order` for the given category ids to their index in the body array (0 = first). |

### Places

| Method | Path                                 | Auth         | Description |
|--------|--------------------------------------|--------------|-------------|
| GET    | `/places`                            | Public       | List places. Only `published === true` places are returned (query against the sparse `GSI1`) — for everyone. Paginated: `?take` (default 20, max 100) and `?cursor`. |
| GET    | `/places?published=false\|all`       | JWT + owner/admin | List unpublished places only (`false`) or every place regardless of visibility (`all`). An admin gets every place (via `GSI2`); an owner gets only the places they own (whose `ownerBy` lists them). The JWT is verified inside the handler rather than by the Gateway authorizer; `401` if it's missing or invalid, `403` unless the caller is an owner/admin. |
| POST   | `/places`                            | JWT + owner/admin | Create a place, owned by the caller. Always created as `status: draft`, `published: false`. |
| GET    | `/places/{id}`                       | Public       | Preview a single place, including its `locations` (oldest first) and visible `offers` (see [Place offers](#place-offers)). Ignores `published`/`status` — returns regardless of visibility state. Soft-deleted locations are hidden unless `?deleted=true`, in which case they're included with `deleted: true`. |
| PUT    | `/places/{id}`                       | JWT + place owner/admin | Update `name`/`description`/`categoryId`/`website`. Resets `status` to `reviewing` as a side effect; never touches `published`. `photo`/`logo`/`status`/`reason`/`published` in the body are ignored. |
| PATCH  | `/places/{id}/publish`               | JWT + place owner/admin | Publish a place. Only succeeds when `status === active`. |
| PATCH  | `/places/{id}/unpublish`             | JWT + place owner/admin | Unpublish a place. Always succeeds; clears `published` and `GSI1PK` regardless of current status. |
| PATCH  | `/places/{id}/review`                | JWT + admin  | Set a place's `status` to the value given in the body (`{ status: PlaceStatus }`). Rejects any value not in the `PlaceStatus` enum; doesn't touch `published`. |
| PATCH  | `/places/{id}/images/{type}`         | JWT + place owner/admin | Issue a presigned S3 PUT URL for the place's `photo` or `logo` (`{type}` is one of those two values, uploaded separately). Body: `{ contentType }` (`image/jpeg`\|`image/png`\|`image/webp`). Writes the resulting URL to `draftPhoto`/`draftLogo` — optimistic, before the client's S3 PUT actually completes, but never touches the public `photo`/`logo` field. |
| PATCH  | `/places/{id}/images/{type}/approve` | JWT + admin  | Promote a pending `draftPhoto`/`draftLogo` to the live `photo`/`logo` field. Copies the S3 object from its draft key to a new versioned live key, then clears the draft and deletes the image it replaced. `400` if there's no pending draft for that type or the draft object isn't actually in S3; `404` if the place doesn't exist. |
| PATCH  | `/places/{id}/grant`                 | JWT + place owner/admin | Give another user ownership of the place, its locations and offers. Body: `{ owner: <userId> }`. `404` if the user doesn't exist, `400` unless their `role` is `owner`, `409` if they already own the place. Returns `{ id, owner }`. |

### Place locations

| Method | Path                                  | Auth                    | Description |
|--------|---------------------------------------|-------------------------|-------------|
| POST   | `/places/{id}/locations`              | JWT + place owner/admin | Add a location to the place (body: `PlaceLocationModel`). Resets the place's `status` to `reviewing`. `404` if the place doesn't exist. |
| GET    | `/places/{id}/locations/{locationId}` | JWT + place owner/admin | Preview a single location (for populating the edit form), including its visible offers. `404` if missing or soft-deleted. |
| PUT    | `/places/{id}/locations/{locationId}` | JWT + place owner/admin | Replace a location's fields — full replacement, so omitted optional fields are cleared. Resets the place's `status` to `reviewing`. `404` if missing or soft-deleted. |
| DELETE | `/places/{id}/locations/{locationId}` | JWT + place owner/admin | Soft-delete a location (`deleted: true`; never hard-deleted). Resets the place's `status` to `reviewing`. |

### Place offers

| Method | Path                            | Auth                    | Description |
|--------|---------------------------------|-------------------------|-------------|
| POST   | `/places/{id}/offers`           | JWT + place owner/admin | Create an offer (body: `{ title, discount?, start?, end?, status? }`, see below). A place offer, or a location offer with `?location=<locationId>` — the link is fixed at creation. `status` defaults to `active`. `404` if the place doesn't exist, `400` if the location doesn't (or is soft-deleted). |
| GET    | `/places/{id}/offers`           | JWT + place owner/admin | List every offer of the place, any status, newest first. Paginated: `?take` (default 20, max 100) and `?cursor` (`meta.nextCursor` of the previous page). |
| GET    | `/places/{id}/offers/{offerId}` | JWT + place owner/admin | Preview a single offer, any status. |
| PUT    | `/places/{id}/offers/{offerId}` | JWT + place owner/admin | Replace an offer's `title`/`discount`/`start`/`end` — full replacement, so omitted optional fields are cleared. `status` is optional: omitted keeps the current one, `active` reactivates a canceled offer. |
| DELETE | `/places/{id}/offers/{offerId}` | JWT + place owner/admin | Cancel an offer (`status: canceled`; never deleted). |

> [!NOTE]
> - `discount` is a positive number
> - `start`/`end` are ISO 8601 date-times with a timezone offset (e.g. `2026-10-31T23:59:59-03:00`), stored in UTC. 
> - only `active` and `canceled` status are ever stored
> - an active offer is shown as `expired` once its `end` is reached. 
> - offers endpoints return each offer with a `place` (`id`/`name`/`logo`)
> - for location offers, a `location` (`id`/`name`/`city`/`state`) summary.
> - published offers are the ones with `active` status that has been started (when `start` are reached) and are not expired
> - The publice endpoint `GET /places/{id}` lists *published* place offers in its top-level `offers` attribute and location offers under `locations.offers` attribute 
> - `GET /places/{id}/locations/{locationId}` list all offers

## Project structure

```
bin/bp-api.ts                  CDK app entry point
lib/bp-api-stack.ts            Infrastructure (API GW, Cognito, DynamoDB, Lambdas)
src/handlers/                  Lambda entry points (one bundle each, grouped by entity)
src/models/                    Per-entity model types (client-facing, DynamoDB item, mapper)
src/lib/                       Shared: Powertools, DynamoDB client, S3 client, HTTP helpers, auth/role checks, pagination, place reads
scripts/build.mjs              esbuild bundler (--watch for live reload)
scripts/create-local-table.mjs Local DynamoDB table bootstrap
scripts/create-local-bucket.mjs Local MinIO bucket bootstrap
test/                          Jest: handler/model/lib tests + CDK assertions
docker-compose.yml             DynamoDB Local (:8000) + admin UI (:8001) + MinIO (:9000, console :9001)
env.json                       Env overrides for SAM local
```

Adding a new endpoint: create `src/handlers/<entity>/<name>.ts` (and a `src/models/<entity>.ts` if it's a new entity) → add it to `entries` in `scripts/build.mjs` → wire the function + route in `lib/bp-api-stack.ts` → `bun run synth`.

## Roadmap / next steps

- CI/CD with CodePipeline (CDK Pipelines) — deploy on push
- CloudWatch alarms + dashboard for API 5xx, Lambda errors, DynamoDB throttles
- Owner user search (`name`/`email`) for picking who to grant place ownership to, and revoking a place owner
- Role-based authorization on category endpoints (any authenticated user can mutate them today)
- Request validation with API Gateway models or zod
