import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, forbidden, json, notFound, serverError } from '../../lib/http';
import { loadPlacePartition } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import { OfferItem, offerKey, toOfferModel } from '../../models/offer';
import { canManagePlace, PLACE_ACCESS_DENIED } from '../../models/place';
import { UserRole } from '../../models/user';

/**
 * Preview Offer
 *
 * GET /places/{id}/offers/{offerId} (Cognito-protected, place owner/admin only)
 * Any status — used to populate the offer edit form. 404 when the offer
 * belongs to another place.
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

    const [result, { place, locations }] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: offerKey(id) })),
      loadPlacePartition(placeId),
    ]);

    if (!place) return notFound('Place not found');
    if (!canManagePlace(access.user, place)) return forbidden(PLACE_ACCESS_DENIED);

    const item = result.Item as OfferItem | undefined;
    if (!item || item.placeId !== placeId) return notFound('Offer not found');

    const location = locations.find((candidate) => candidate.id === item.locationId);

    return json(200, toOfferModel(item, new Date(), { place, location }));
  } catch (error) {
    logger.error('Failed to preview offer', error as Error);
    return serverError();
  }
};
