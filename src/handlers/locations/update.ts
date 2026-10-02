import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { locationKey, toLocationModel } from '../../models/location';
import { UserRole } from '../../models/user';
import { LocationFields, parseLocationDto } from './dto';
import { conditionFailedAt, placeReviewUpdate } from './transaction';

/**
 * Update Location
 *
 * PUT /places/{id}/locations/{locationId} (Cognito-protected, owner/admin only)
 * Full replacement of the location's fields (omitted optional fields are
 * cleared); resets the place to reviewing. Soft-deleted locations are 404.
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

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const parsed = parseLocationDto(body);
  if ('error' in parsed) return badRequest(parsed.error);
  const { fields } = parsed;

  try {
    const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
    if ('response' in access) return access.response;

    const now = new Date().toISOString();

    const names: Record<string, string> = { '#deleted': 'deleted', '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = { ':false': false, ':updatedAt': now };
    const sets: string[] = ['#updatedAt = :updatedAt'];
    for (const field of Object.keys(fields) as (keyof LocationFields)[]) {
      names[`#${field}`] = field;
      values[`:${field}`] = fields[field];
      sets.push(`#${field} = :${field}`);
    }

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: locationKey(placeId, id),
              UpdateExpression: `SET ${sets.join(', ')}`,
              ConditionExpression: 'attribute_exists(PK) AND #deleted = :false',
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
          placeReviewUpdate(placeId, now),
        ],
      }),
    );

    logger.info('Location updated', { placeId, id });
    return json(200, toLocationModel({ id, ...fields, deleted: false }));
  } catch (error) {
    if (conditionFailedAt(error, 1)) return notFound('Place not found');
    if (conditionFailedAt(error, 0)) return notFound('Location not found');
    logger.error('Failed to update location', error as Error);
    return serverError();
  }
};
