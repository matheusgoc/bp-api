import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, QueryCommandInput } from '@aws-sdk/lib-dynamodb';
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

// Runs a Query against the table to completion, following LastEvaluatedKey across
// pages — only for result sets known to stay small (a place's partition, its live offers)
export const queryAll = async (
  input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>,
): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({ ...input, TableName: TABLE_NAME, ExclusiveStartKey }),
    );
    items.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};
