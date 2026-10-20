import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { loadLiveOffers } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import { LocationItem, locationKey, toLocationModel } from '../../models/location';
import { toOfferModel } from '../../models/offer';
import { UserRole } from '../../models/user';

/**
 * Preview Location
 *
 * GET /places/{id}/locations/{locationId} (Cognito-protected, owner/admin only)
 * Used to populate the location edit form, including the location's visible offers
 * (active, started, not expired). Soft-deleted locations are 404.
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
    const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
    if ('response' in access) return access.response;

    const now = new Date();
    const [result, offers] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: locationKey(placeId, id) })),
      loadLiveOffers(placeId, now),
    ]);

    const item = result.Item as LocationItem | undefined;
    if (!item || item.deleted) return notFound('Location not found');

    const locationOffers = offers
      .filter((offer) => offer.locationId === id)
      .map((offer) => toOfferModel(offer, now));

    return json(200, toLocationModel(item, locationOffers));
  } catch (error) {
    logger.error('Failed to preview location', error as Error);
    return serverError();
  }
};
