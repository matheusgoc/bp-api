import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, forbidden, json, notFound, serverError } from '../../lib/http';
import { decodeCursor, encodeCursor, parseTake } from '../../lib/pagination';
import { loadPlacePartition } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import { OfferItem, placeOffersKey, toOfferModel } from '../../models/offer';
import { canManagePlace, PLACE_ACCESS_DENIED } from '../../models/place';
import { UserRole } from '../../models/user';

/**
 * List Offers
 *
 * GET /places/{id}/offers (Cognito-protected, place owner/admin only)
 * every offer of the place no matter the status, newest first (GSI2)
 * ?take (default 20, capped at 100)
 * ?cursor — cursor-based pagination, tied to the place
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const placeId = event.pathParameters?.id;
  if (!placeId) return badRequest('"id" path parameter is required');

  const parsedTake = parseTake(event.queryStringParameters?.take);
  if ('error' in parsedTake) return badRequest(parsedTake.error);
  const { take } = parsedTake;

  const cursorParam = event.queryStringParameters?.cursor;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursorParam) {
    exclusiveStartKey = decodeCursor(cursorParam, placeId);
    if (!exclusiveStartKey) return badRequest('"cursor" is invalid');
  }

  try {
    const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
    if ('response' in access) return access.response;

    const [result, { place, locations }] = await Promise.all([
      ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': placeOffersKey(placeId) },
          ScanIndexForward: false, // newest first
          Limit: take,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      ),
      loadPlacePartition(placeId),
    ]);
    if (!place) return notFound('Place not found');
    if (!canManagePlace(access.user, place)) return forbidden(PLACE_ACCESS_DENIED);

    const now = new Date();
    const locationsById = new Map(locations.map((location) => [location.id, location]));
    const data = ((result.Items ?? []) as OfferItem[]).map((item) =>
      toOfferModel(item, now, { place, location: locationsById.get(item.locationId) }),
    );
    const nextCursor = result.LastEvaluatedKey
      ? encodeCursor(placeId, result.LastEvaluatedKey)
      : null;

    logger.info('Offers listed', { placeId, count: data.length, take, hasNextPage: !!nextCursor });
    return json(200, {
      data,
      meta: {
        take,
        hasPreviousPage: !!cursorParam,
        hasNextPage: !!nextCursor,
        nextCursor,
      },
    });
  } catch (error) {
    logger.error('Failed to list offers', error as Error);
    return serverError();
  }
};
