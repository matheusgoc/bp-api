import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { requirePlaceAccess } from '../../lib/access';
import { conditionFailedAt, ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { locationKey } from '../../models/location';
import { placeReviewUpdate } from './transaction';

/**
 * Remove Location
 *
 * DELETE /places/{id}/locations/{locationId} (Cognito-protected, place owner/admin only)
 * Soft delete — flags the location as deleted (hidden from place preview unless
 * ?deleted=true) and resets the place to reviewing. A location is never hard-deleted.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const placeId = event.pathParameters?.id;
  const id = event.pathParameters?.locationId;
  if (!placeId) return badRequest('"id" path parameter is required');
  if (!id) return badRequest('"locationId" path parameter is required');

  try {
    const access = await requirePlaceAccess(event, placeId);
    if ('response' in access) return access.response;

    const now = new Date().toISOString();

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: locationKey(placeId, id),
              UpdateExpression: 'SET #deleted = :true, deletedAt = :now, updatedAt = :now',
              ConditionExpression: 'attribute_exists(PK) AND #deleted = :false',
              ExpressionAttributeNames: { '#deleted': 'deleted' },
              ExpressionAttributeValues: { ':true': true, ':false': false, ':now': now },
            },
          },
          placeReviewUpdate(placeId, now),
        ],
      }),
    );

    logger.info('Location removed', { placeId, id });
    return json(200, { id });
  } catch (error) {
    if (conditionFailedAt(error, 1)) return notFound('Place not found');
    if (conditionFailedAt(error, 0)) return notFound('Location not found');
    logger.error('Failed to remove location', error as Error);
    return serverError();
  }
};
