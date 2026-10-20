import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { loadPlacePartition } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import { OfferItem, offerKey, OfferStatus, toOfferModel } from '../../models/offer';
import { UserRole } from '../../models/user';

/**
 * Cancel Offer
 *
 * DELETE /places/{id}/offers/{offerId} (Cognito-protected, owner/admin only)
 * Sets status to canceled and removes GSI1PK, so previews stop showing the offer.
 * An offer is never deleted; canceling is idempotent and update can reactivate it.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const placeId = event.pathParameters?.id;
  const id = event.pathParameters?.offerId;
  if (!placeId) return badRequest('"id" path parameter is required');
  if (!id) return badRequest('"offerId" path parameter is required');

  try {
    const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
    if ('response' in access) return access.response;

    const now = new Date();

    const [result, { place, locations }] = await Promise.all([
      ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: offerKey(id),
          UpdateExpression: 'SET #status = :canceled, updatedAt = :updatedAt REMOVE GSI1PK',
          ConditionExpression: 'attribute_exists(PK) AND placeId = :placeId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':canceled': OfferStatus.CANCELED,
            ':updatedAt': now.toISOString(),
            ':placeId': placeId,
          },
          ReturnValues: 'ALL_NEW',
        }),
      ),
      loadPlacePartition(placeId),
    ]);

    const item = result.Attributes as OfferItem;
    const location = locations.find((candidate) => candidate.id === item.locationId);

    logger.info('Offer canceled', { placeId, id });
    return json(200, toOfferModel(item, now, { place, location }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return notFound('Offer not found');
    logger.error('Failed to cancel offer', error as Error);
    return serverError();
  }
};
