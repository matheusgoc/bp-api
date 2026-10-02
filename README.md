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
2. **Upload** — the app PUTs the file bytes directly to that URL (e.g. with `expo-file-system`'s `uploadAsync`); the draft key is recorded on the entity but never exposed through the public API.
3. **Approve** — an endpoint like `PATCH /places/{id}/images/{type}/approve` copies the object server-side from its draft key to its live, public key and only then clears the draft. This is the hook point for future image verification/moderation before anything goes public.

**Local**: MinIO (S3-compatible) runs via `docker compose up -d`, bucket created by `bun local:bucket`. Two env vars point at it for different reasons — `S3_ENDPOINT` (server-side calls like approve) must resolve inside the docker network (`http://minio:9000`); `S3_PRESIGN_ENDPOINT` (baked into presigned URLs) must resolve from the host (`http://localhost:9000`).

**Production (AWS)**: the bucket is provisioned by CDK with CORS enabled and public read scoped to live keys only — draft keys stay private until promoted via approve.

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
- DynamoDB uses single-table design: places are `PK=PLACE#<id>, SK=METADATA`. `GSI1PK` is **sparse** — it's only set to `PLACE#PUBLISHED` while a place is published, so `GET /places` is a plain query against `GSI1` with no filter expression, and naturally excludes drafts/unpublished places. `GSI2PK` is always `'PLACE'` (set once at creation) and backs the unrestricted `?published=all`/`?published=false` listing views. **category** reuses the exact same pattern (`PK=CATEGORY#<id>`, `GSI1PK='CATEGORY#ENABLED'` sparse on `enabled`, `GSI2PK='CATEGORY'` always) in the same table — no schema change was needed. **Locations** live in their place's partition (`PK=PLACE#<placeId>, SK=LOCATION#<id>`, no GSI attributes), so `GET /places/{id}` fetches a place and all its locations with a single query.
- The domain model is **place** (central), **location**, **offer**, **category**, **user** — a place has many locations and offers, one category, and one or more owning users. **place**, **category**, **user** (profile), and **location** are implemented so far; **offer** is planned (see Roadmap).

## Endpoints

| Method | Path                    | Auth         | Description |
|--------|-------------------------|--------------|-------------|
| GET    | `/health`               | Public       | Health check. |
| POST   | `/profile`              | JWT required | Create the caller's app-level profile — called by the app after Amplify Cognito signup/confirm/signin. Requires `name`/`email`; `phone`/`isWhatsapp`/`dob`/`gender` optional. Created as `role: customer`, `subscriptionStatus: not_applied`. `409` if the caller already has a profile. |
| GET    | `/profile`              | JWT required | Preview the caller's own profile (resolved from the token, never a path parameter). |
| PUT    | `/profile`              | JWT required | Update the caller's own `name`/`email`/`phone`/`dob`/`gender`/`isWhatsapp`. |
| PATCH  | `/profile/convert`      | JWT required | Convert the caller to `owner` (no body needed). If the caller is an `admin` and the body has `{ id, type? }`, converts that *other* user instead to `type` (any role, default `owner`) — `400` if `id` is the caller's own, `404` if the user doesn't exist. Non-admins' `id`/`type` are ignored. |
| GET    | `/categories`           | Public       | List categories. `?enabled=` (`true`/`false`/`all`) |
| POST   | `/categories`           | JWT required | Create a category. Always created `enabled: true` (no draft state). |
| GET    | `/categories/{id}`      | Public       | Preview a single category. |
| PUT    | `/categories/{id}`      | JWT required | Update `name`/`description` only. |
| PATCH  | `/categories/{id}/enable` | JWT required | Set `enabled: true`. |
| PATCH  | `/categories/{id}/disable`| JWT required | Set `enabled: false`. |
| PATCH  | `/categories/reorder`   | JWT required | Rewrite `order` for the given category ids to their index in the body array (0 = first). |
| GET    | `/places`               | Public       | List places. Only `published === true` places are returned (query against the sparse `GSI1`). |
| POST   | `/places`               | JWT required | Create a place. Always created as `status: draft`, `published: false`. |
| GET    | `/places/{id}`          | Public       | Preview a single place, including its `locations` (oldest first). Ignores `published`/`status` — returns regardless of visibility state. Soft-deleted locations are hidden unless `?deleted=true`, in which case they're included with `deleted: true`. |
| PUT    | `/places/{id}`          | JWT required | Update `name`/`description`/`categoryId`/`website`. Resets `status` to `reviewing` as a side effect; never touches `published`. `photo`/`logo`/`status`/`reason`/`published` in the body are ignored. |
| PATCH  | `/places/{id}/publish`  | JWT required | Publish a place. Only succeeds when `status === active`. |
| PATCH  | `/places/{id}/unpublish`| JWT required | Unpublish a place. Always succeeds; clears `published` and `GSI1PK` regardless of current status. |
| PATCH  | `/places/{id}/review`   | JWT required | Set a place's `status` to the value given in the body (`{ status: PlaceStatus }`). Rejects any value not in the `PlaceStatus` enum; doesn't touch `published`. |
| PATCH  | `/places/{id}/images/{type}` | JWT required | Issue a presigned S3 PUT URL for the place's `photo` or `logo` (`{type}` is one of those two values, uploaded separately). Body: `{ contentType }` (`image/jpeg`\|`image/png`\|`image/webp`). Writes the resulting URL to `draftPhoto`/`draftLogo` — optimistic, before the client's S3 PUT actually completes, but never touches the public `photo`/`logo` field. |
| PATCH  | `/places/{id}/images/{type}/approve` | JWT required | Promote a pending `draftPhoto`/`draftLogo` to the live `photo`/`logo` field. Copies the S3 object from its draft key to its live key, then clears the draft. `400` if there's no pending draft for that type or the draft object isn't actually in S3; `404` if the place doesn't exist. |
| POST   | `/places/{id}/locations` | JWT + owner/admin | Add a location to the place (body: `PlaceLocationModel`, see below). Resets the place's `status` to `reviewing`. `404` if the place doesn't exist. |
| GET    | `/places/{id}/locations/{locationId}` | JWT + owner/admin | Preview a single location (for populating the edit form). `404` if missing or soft-deleted. |
| PUT    | `/places/{id}/locations/{locationId}` | JWT + owner/admin | Replace a location's fields — full replacement, so omitted optional fields are cleared. Resets the place's `status` to `reviewing`. `404` if missing or soft-deleted. |
| DELETE | `/places/{id}/locations/{locationId}` | JWT + owner/admin | Soft-delete a location (`deleted: true`; never hard-deleted). Resets the place's `status` to `reviewing`. |

JWT-required routes expect `Authorization: Bearer <idToken>` (Cognito), enforced by API Gateway's Cognito authorizer in AWS. **SAM local does not enforce it** — those routes work locally without a token.

"owner/admin" routes additionally look up the caller's profile and return `403` unless its `role` is `owner` or `admin`. There's no per-place ownership check yet — any owner can manage any place's locations.

## Project structure

```
bin/bp-api.ts                  CDK app entry point
lib/bp-api-stack.ts            Infrastructure (API GW, Cognito, DynamoDB, Lambdas)
src/handlers/                  Lambda entry points (one bundle each, grouped by entity)
src/models/                    Per-entity model types (client-facing, DynamoDB item, mapper)
src/lib/                       Shared: Powertools, DynamoDB client, S3 client, HTTP helpers, auth/role checks
scripts/build.mjs              esbuild bundler (--watch for live reload)
scripts/create-local-table.mjs Local DynamoDB table bootstrap
scripts/create-local-bucket.mjs Local MinIO bucket bootstrap
test/                          Jest: handler tests + CDK assertions
docker-compose.yml             DynamoDB Local (:8000) + admin UI (:8001) + MinIO (:9000, console :9001)
env.json                       Env overrides for SAM local
```

Adding a new endpoint: create `src/handlers/<entity>/<name>.ts` (and a `src/models/<entity>.ts` if it's a new entity) → add it to `entries` in `scripts/build.mjs` → wire the function + route in `lib/bp-api-stack.ts` → `bun run synth`.

## Roadmap / next steps

- CI/CD with CodePipeline (CDK Pipelines) — deploy on push
- CloudWatch alarms + dashboard for API 5xx, Lambda errors, DynamoDB throttles
- Offer entity/feature (the last of the five domain entities)
- Role and ownership-based authorization on place/category endpoints, plus per-place ownership on location endpoints (these are only role-gated to owner/admin today) — `PATCH /places/{id}/review` currently accepts any authenticated user, with no admin-only restriction
- Request validation with API Gateway models or zod
