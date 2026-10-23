// Creates the local MinIO bucket - mirrors the CDK bucket definition
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

// Reapplied every run regardless of whether the bucket was just created
// so, local behavior matches the CDK bucket's public-read policy
// every place image under places/, live and draft
// the owner/admin management view shows a draft before it's promoted via PATCH .../approve
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
          Resource: [`arn:aws:s3:::${BUCKET_NAME}/places/*`],
        },
      ],
    }),
  }),
);

console.log(`✅ Public-read policy (place images) applied to "${BUCKET_NAME}"`);
