import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, forbidden, json, notFound, serverError } from '../../lib/http';
import { loadPlacePartition } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import { activeOffersKey, OfferItem, offerKey, OfferStatus, toOfferModel } from '../../models/offer';
import { canManagePlace, PLACE_ACCESS_DENIED } from '../../models/place';
import { UserRole } from '../../models/user';

/**
 * Enable Offer
 *
 * PATCH /places/{id}/offers/{offerId} (Cognito-protected, place owner/admin only)
 * Sets status to active and restores GSI1PK, so previews show the offer again once
 * it has started (and until it expires). The counterpart of cancel: idempotent, and
 * leaves title/discount/start/end untouched. GSI1SK (the end) is always present.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const placeId = event.pathParameters?.id;
  const id = event.pathParameters?.offerId;
  if (!placeId) return badRequest('PATH_PARAMETER_REQUIRED', 'id');
  if (!id) return badRequest('PATH_PARAMETER_REQUIRED', 'offerId');

  try {
    const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
    if ('response' in access) return access.response;

    // ownership is checked before the write, so the place is loaded first
    const { place, locations } = await loadPlacePartition(placeId);
    if (!place) return notFound('Place not found');
    if (!canManagePlace(access.user, place)) return forbidden(PLACE_ACCESS_DENIED);

    const now = new Date();

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: offerKey(id),
        UpdateExpression: 'SET #status = :active, updatedAt = :updatedAt, GSI1PK = :gsi1pk',
        ConditionExpression: 'attribute_exists(PK) AND placeId = :placeId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': OfferStatus.ACTIVE,
          ':updatedAt': now.toISOString(),
          ':gsi1pk': activeOffersKey(placeId),
          ':placeId': placeId,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    const item = result.Attributes as OfferItem;
    const location = locations.find((candidate) => candidate.id === item.locationId);

    logger.info('Offer enabled', { placeId, id });
    return json(200, toOfferModel(item, now, { place, location }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return notFound('Offer not found');
    logger.error('Failed to enable offer', error as Error);
    return serverError();
  }
};
