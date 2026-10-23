import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, forbidden, json, notFound, serverError } from '../../lib/http';
import { loadPlacePartition } from '../../lib/placeReads';
import { logger } from '../../lib/powertools';
import {
  activeOffersKey,
  offerEndSortKey,
  OfferItem,
  offerKey,
  OfferStatus,
  toOfferModel,
} from '../../models/offer';
import { canManagePlace, PLACE_ACCESS_DENIED } from '../../models/place';
import { UserRole } from '../../models/user';
import { OfferFields, parseOfferDto } from './dto';

/**
 * Update Offer
 *
 * PUT /places/{id}/offers/{offerId} (Cognito-protected, place owner/admin only)
 * Full replacement of title/discount/start/end (omitted optional fields are cleared).
 * status is optional — omitted keeps the current one; active reactivates a canceled
 * offer. The offer's location is fixed at creation.
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

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const parsed = parseOfferDto(body);
  if ('error' in parsed) return badRequest(parsed.error);
  const { fields, status } = parsed;

  try {
    const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
    if ('response' in access) return access.response;

    // ownership is checked before the write, so the place is loaded first
    const { place, locations } = await loadPlacePartition(placeId);
    if (!place) return notFound('Place not found');
    if (!canManagePlace(access.user, place)) return forbidden(PLACE_ACCESS_DENIED);

    const now = new Date();

    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = {
      ':placeId': placeId,
      ':updatedAt': now.toISOString(),
      ':gsi1sk': offerEndSortKey(fields.end),
    };
    const sets: string[] = ['#updatedAt = :updatedAt', 'GSI1SK = :gsi1sk'];
    for (const field of Object.keys(fields) as (keyof OfferFields)[]) {
      names[`#${field}`] = field;
      values[`:${field}`] = fields[field];
      sets.push(`#${field} = :${field}`);
    }

    // status drives the sparse GSI1PK: present while active, removed once canceled
    let remove = '';
    if (status) {
      names['#status'] = 'status';
      values[':status'] = status;
      sets.push('#status = :status');
      if (status === OfferStatus.ACTIVE) {
        values[':gsi1pk'] = activeOffersKey(placeId);
        sets.push('GSI1PK = :gsi1pk');
      } else {
        remove = ' REMOVE GSI1PK';
      }
    }

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: offerKey(id),
        UpdateExpression: `SET ${sets.join(', ')}${remove}`,
        ConditionExpression: 'attribute_exists(PK) AND placeId = :placeId',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );

    const item = result.Attributes as OfferItem;
    const location = locations.find((candidate) => candidate.id === item.locationId);

    logger.info('Offer updated', { placeId, id });
    return json(200, toOfferModel(item, now, { place, location }));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return notFound('Offer not found');
    logger.error('Failed to update offer', error as Error);
    return serverError();
  }
};
