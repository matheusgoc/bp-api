import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
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

// Fetches items by key with BatchGetItem, re-sending UnprocessedKeys until every key is answered 
// Returns them in no particular order; missing keys are simply absent
// At most 100 keys per call (BatchGetItem's limit) — callers pass one listing page at a time.
export const batchGetAll = async (
  keys: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  let pending = keys;
  while (pending.length) {
    const result = await ddb.send(
      new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: pending } } }),
    );
    items.push(...(result.Responses?.[TABLE_NAME] ?? []));
    pending = result.UnprocessedKeys?.[TABLE_NAME]?.Keys ?? [];
  }
  return items;
};

// True when a TransactWriteCommand was cancelled because the item at `index` failed
// its ConditionExpression (CancellationReasons is positional, one per TransactItem)
export const conditionFailedAt = (error: unknown, index: number): boolean =>
  error instanceof TransactionCanceledException &&
  error.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';
