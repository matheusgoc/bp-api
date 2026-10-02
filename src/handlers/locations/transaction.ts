import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TABLE_NAME } from '../../lib/dynamo';
import { PlaceStatus } from '../../models/place';

// Transaction item that resets the parent place back to review — every
// location mutation is a place edit, same side effect as PUT /places/{id}.
// Its condition doubles as the "place exists" check.
export const placeReviewUpdate = (placeId: string, now: string) => ({
  Update: {
    TableName: TABLE_NAME,
    Key: { PK: `PLACE#${placeId}`, SK: 'METADATA' },
    UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': PlaceStatus.REVIEWING, ':updatedAt': now },
  },
});

// True when the transaction was cancelled because the item at `index` failed
// its ConditionExpression.
export const conditionFailedAt = (error: unknown, index: number): boolean =>
  error instanceof TransactionCanceledException &&
  error.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';
