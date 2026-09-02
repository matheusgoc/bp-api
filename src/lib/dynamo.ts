import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tracer } from './powertools';

const isLocal = !!process.env.DYNAMODB_ENDPOINT;

const client = new DynamoDBClient(
  isLocal
    ? {
        endpoint: process.env.DYNAMODB_ENDPOINT,
        region: 'local',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }
    : {},
);

// X-Ray instrumentation (no-op when tracing is disabled, e.g. locally)
tracer.captureAWSv3Client(client);

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAME = process.env.TABLE_NAME ?? '';
