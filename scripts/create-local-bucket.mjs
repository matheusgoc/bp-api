// Creates the local MinIO bucket (mirrors the CDK bucket definition).
// Requires MinIO running: npm run local:storage
import {
  S3Client,
  CreateBucketCommand,
  PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";

const BUCKET_NAME = process.env.BUCKET_NAME ?? "bp-api-local";
const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";

const client = new S3Client({
  endpoint: ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "local", secretAccessKey: "local12345" },
  forcePathStyle: true,
  requestHandler: { requestTimeout: 10_000 },
  // Some S3-compatible servers (older MinIO releases included) don't
  // implement the SDK's default (post-Dec-2024) automatic request checksum
  // headers for every operation — without this, calls whose checksum isn't
  // strictly required fail with "NotImplemented: A header you provided
  // implies functionality that is not implemented".
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

try {
  await client.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
  console.log(`✅ Bucket "${BUCKET_NAME}" created at ${ENDPOINT}`);
} catch (error) {
  if (error.name === "BucketAlreadyOwnedByYou") {
    console.log(`ℹ️  Bucket "${BUCKET_NAME}" already exists — nothing to do`);
  } else {
    console.error("❌ Failed to create bucket:", error.message);
    process.exit(1);
  }
}

// No PutBucketCors call here: MinIO's community server doesn't support the
// S3 PutBucketCors API at all (even its own `mc cors set` CLI fails against
// it with "NotImplemented") — but it doesn't need it either, since MinIO
// responds permissively to cross-origin requests out of the box (verified:
// an OPTIONS preflight against a fresh bucket already echoes back
// Access-Control-Allow-Origin/-Methods/-Headers with no bucket config set).
// The real S3 bucket (`lib/bp-api-stack.ts`) still gets an explicit CORS
// policy via CDK, since AWS S3 — unlike MinIO — requires one.

// Reapplied every run regardless of whether the bucket was just created, so
// local behavior matches the CDK bucket's public-read policy — scoped to
// live keys only (places/{id}/photo.{ext}, places/{id}/logo.{ext}), not
// draft keys (places/{id}/{type}-draft.{ext}), so an unapproved upload isn't
// publicly fetchable before it's promoted via PATCH .../approve.
await client.send(
  new PutBucketPolicyCommand({
    Bucket: BUCKET_NAME,
    Policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [
            `arn:aws:s3:::${BUCKET_NAME}/places/*/photo.*`,
            `arn:aws:s3:::${BUCKET_NAME}/places/*/logo.*`,
          ],
        },
      ],
    }),
  }),
);

console.log(`✅ Public-read policy (live keys only) applied to "${BUCKET_NAME}"`);
