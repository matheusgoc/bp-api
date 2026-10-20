import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { loadPlacePartition } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import {
  activeOffersKey,
  offerEndSortKey,
  OfferItem,
  offerKey,
  OfferStatus,
  placeOffersKey,
  toOfferModel,
} from '../../models/offer';
import { UserRole } from '../../models/user';
import { parseOfferDto } from './dto';

/**
 * Add Offer
 *
 * POST /places/{id}/offers[?location=<locationId>] (Cognito-protected, owner/admin only)
 * Creates a place offer, or a location offer when ?location is given — the link is set
 * only here, update can't move an offer. Status defaults to active.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const placeId = event.pathParameters?.id;
  if (!placeId) return badRequest('"id" path parameter is required');

  const locationParam = event.queryStringParameters?.location;
  if (locationParam !== undefined && !locationParam.trim()) {
    return badRequest('"location" cannot be empty');
  }
  const locationId = locationParam?.trim() ?? '';

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const parsed = parseOfferDto(body);
  if ('error' in parsed) return badRequest(parsed.error);

  try {
    const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
    if ('response' in access) return access.response;

    const { place, locations } = await loadPlacePartition(placeId);
    if (!place) return notFound('Place not found');

    const location = locationId
      ? locations.find((candidate) => candidate.id === locationId && !candidate.deleted)
      : undefined;
    if (locationId && !location) return badRequest('"location" does not exist');

    const id = randomUUID();
    const now = new Date();
    const createdAt = now.toISOString();
    const status = parsed.status ?? OfferStatus.ACTIVE;

    const item: OfferItem = {
      ...offerKey(id),
      // sparse — only active offers are in the previews' live-offers index
      ...(status === OfferStatus.ACTIVE ? { GSI1PK: activeOffersKey(placeId) } : {}),
      GSI1SK: offerEndSortKey(parsed.fields.end),
      GSI2PK: placeOffersKey(placeId),
      GSI2SK: createdAt,
      id,
      placeId,
      locationId,
      ...parsed.fields,
      status,
      createdAt,
      createdBy: access.user.id,
      updatedAt: createdAt,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );

    logger.info('Offer created', { placeId, id, locationId });
    return json(201, toOfferModel(item, now, { place, location }));
  } catch (error) {
    logger.error('Failed to create offer', error as Error);
    return serverError();
  }
};
