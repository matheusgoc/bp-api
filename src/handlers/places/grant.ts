import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { requirePlaceAccess } from '../../lib/access';
import { conditionFailedAt, ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, conflict, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceOwnershipItem, placeOwnershipKey } from '../../models/place';
import { UserItem, UserRole } from '../../models/user';

interface GrantDto {
  owner?: unknown;
}

/**
 * Grant Place Ownership
 *
 * PATCH /places/{id}/grant (Cognito-protected, place owner/admin only)
 * Adds another owner user to the place's ownerBy, giving them access to the place,
 * its locations and offers.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  let grantDto: GrantDto;
  try {
    grantDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const owner = typeof grantDto.owner === 'string' ? grantDto.owner.trim() : '';
  if (!owner) return badRequest('"owner" is required');

  try {
    const access = await requirePlaceAccess(event, id);
    if ('response' in access) return access.response;
    const { user, place } = access;

    if ((place.ownerBy ?? []).includes(owner)) return conflict('User already owns this place');

    const target = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USER#${owner}`, SK: 'METADATA' } }),
    );
    const targetUser = target.Item as UserItem | undefined;
    if (!targetUser) return notFound('User not found');
    if (targetUser.role !== UserRole.OWNER) {
      return badRequest('"owner" must be a user with the owner role');
    }

    const now = new Date().toISOString();
    const ownership: PlaceOwnershipItem = {
      ...placeOwnershipKey(owner, place),
      placeId: id,
      userId: owner,
      createdAt: now,
      createdBy: user.id,
    };

    // ownerBy and the owner's ownership index item change together
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: `PLACE#${id}`, SK: 'METADATA' },
              UpdateExpression:
                'SET ownerBy = list_append(if_not_exists(ownerBy, :empty), :owners), updatedAt = :now',
              ConditionExpression: 'attribute_exists(PK) AND NOT contains(ownerBy, :owner)',
              ExpressionAttributeValues: {
                ':empty': [],
                ':owners': [owner],
                ':owner': owner,
                ':now': now,
              },
            },
          },
          { Put: { TableName: TABLE_NAME, Item: ownership } },
        ],
      }),
    );

    logger.info('Place ownership granted', { id, owner, grantedBy: user.id });
    return json(200, { id, owner });
  } catch (error) {
    // a concurrent grant of the same owner got there first
    if (conditionFailedAt(error, 0)) return conflict('User already owns this place');
    logger.error('Failed to grant place ownership', error as Error);
    return serverError();
  }
};
