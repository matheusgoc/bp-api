import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { loadLiveOffers, loadPlacePartition } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import { toLocationModel } from '../../models/location';
import { toOfferModel } from '../../models/offer';
import { toPlaceModel } from '../../models/place';

// GET /places/{id}[?deleted=true]
// soft-deleted locations are only included with ?deleted=true.
// visible offers (active, started, not expired) are listed at the top level when they're
// place-level, and nested under their location otherwise.
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  const includeDeleted = event.queryStringParameters?.deleted === 'true';

  try {
    const now = new Date();
    const [{ place, locations }, offers] = await Promise.all([
      loadPlacePartition(id),
      loadLiveOffers(id, now),
    ]);
    if (!place) return notFound('Place not found');

    const offersAt = (locationId: string) =>
      offers
        .filter((offer) => offer.locationId === locationId)
        .map((offer) => toOfferModel(offer, now));

    const locationModels = locations
      .filter((location) => includeDeleted || !location.deleted)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((location) => toLocationModel(location, offersAt(location.id)));

    return json(200, toPlaceModel(place, locationModels, offersAt('')));
  } catch (error) {
    logger.error('Failed to preview place', error as Error);
    return serverError();
  }
};
