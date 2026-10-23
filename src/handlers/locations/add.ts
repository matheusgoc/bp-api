import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { requirePlaceAccess } from '../../lib/access';
import { conditionFailedAt, ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { LocationItem, locationKey, toLocationModel } from '../../models/location';
import { parseLocationDto } from './dto';
import { placeReviewUpdate } from './transaction';

/**
 * Add Location
 *
 * POST /places/{id}/locations (Cognito-protected, place owner/admin only)
 * Creates a location under the place and resets the place to reviewing
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const placeId = event.pathParameters?.id;
  if (!placeId) return badRequest('"id" path parameter is required');

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const parsed = parseLocationDto(body);
  if ('error' in parsed) return badRequest(parsed.error);

  try {
    const access = await requirePlaceAccess(event, placeId);
    if ('response' in access) return access.response;

    const id = randomUUID();
    const now = new Date().toISOString();

    const item: LocationItem = {
      ...locationKey(placeId, id),
      id,
      placeId,
      ...parsed.fields,
      deleted: false,
      deletedAt: '',
      createdAt: now,
      createdBy: access.user.id,
      updatedAt: now,
    };

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: item,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          placeReviewUpdate(placeId, now),
        ],
      }),
    );

    logger.info('Location created', { placeId, id });
    return json(201, toLocationModel(item));
  } catch (error) {
    if (conditionFailedAt(error, 1)) return notFound('Place not found');
    logger.error('Failed to create location', error as Error);
    return serverError();
  }
};
