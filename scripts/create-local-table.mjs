// Creates the local DynamoDB table (mirrors the CDK table definition).
// Requires DynamoDB Local running: npm run local:storage
import { execFileSync } from "node:child_process";
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME ?? "bp-api-local";
const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

// A fresh `dynamodb-data` docker volume mounts owned by root, but the
// container runs as uid 1000 (dynamodblocal) — it can't open its sqlite
// file until this is chowned, and just hangs instead of erroring. Best
// effort: no-op once the volume is already owned correctly, and silently
// skipped if docker/the container isn't around (e.g. CI, non-local endpoint).
try {
  execFileSync(
    "docker",
    [
      "exec",
      "-u",
      "root",
      "bp-dynamodb",
      "chown",
      "-R",
      "dynamodblocal:dynamodblocal",
      "/home/dynamodblocal/data",
    ],
    { stdio: "ignore" },
  );
} catch {
  // not running via docker compose under this container name — fall through
}

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
  requestHandler: { requestTimeout: 10_000 },
});

try {
  await client.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
        { AttributeName: "GSI2PK", AttributeType: "S" },
        { AttributeName: "GSI2SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: "GSI2",
          KeySchema: [
            { AttributeName: "GSI2PK", KeyType: "HASH" },
            { AttributeName: "GSI2SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  console.log(`✅ Table "${TABLE_NAME}" created at ${ENDPOINT}`);
} catch (error) {
  if (error instanceof ResourceInUseException) {
    console.log(`ℹ️  Table "${TABLE_NAME}" already exists — nothing to do`);
  } else {
    console.error("❌ Failed to create table:", error.message);
    process.exit(1);
  }
}
