import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { requirePlaceAccess } from '../../lib/access';
import { conditionFailedAt, ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, conflict, forbidden, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { placeOwnershipKey } from '../../models/place';
import { UserRole } from '../../models/user';

interface RevokeDto {
  owner?: unknown;
}

/**
 * Revoke Place Ownership
 *
 * PATCH /places/{id}/revoke (Cognito-protected, place owner/admin only)
 * Removes another owner from the place's ownerBy, taking away their access to the place,
 * its locations and offers. The caller can't revoke themselves, and only an admin can
 * revoke the place's creator.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('PATH_PARAMETER_REQUIRED', 'id');

  let revokeDto: RevokeDto;
  try {
    revokeDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('INVALID_JSON');
  }

  const owner = typeof revokeDto.owner === 'string' ? revokeDto.owner.trim() : '';
  if (!owner) return badRequest('FIELD_REQUIRED', 'owner');

  try {
    const access = await requirePlaceAccess(event, id);
    if ('response' in access) return access.response;
    const { user, place } = access;

    if (owner === user.id) return badRequest('CANNOT_REVOKE_SELF');

    // ownerBy membership is all that counts — no user lookup, so an owner later
    // converted back to customer (still listed) can be removed too
    const index = (place.ownerBy ?? []).indexOf(owner);
    if (index === -1) return notFound('User does not own this place');

    const isAdmin = user.role === UserRole.ADMIN;
    if (owner === place.createdBy && !isAdmin) {
      return forbidden('Only an admin can revoke the place creator');
    }

    // a list element can only be removed by index, and the index can't be a placeholder
    // so it's written into the expression — it's an integer computed above.
    // The element must still hold this owner (no concurrent change shifted the list),
    // and an owner caller must still be an owner (two owners can't revoke each other at once)
    const conditions = [`ownerBy[${index}] = :owner`];
    const values: Record<string, unknown> = { ':owner': owner, ':now': new Date().toISOString() };
    if (!isAdmin) {
      conditions.push('contains(ownerBy, :caller)');
      values[':caller'] = user.id;
    }

    // ownerBy and the owner's ownership index item change together
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: `PLACE#${id}`, SK: 'METADATA' },
              UpdateExpression: `SET updatedAt = :now REMOVE ownerBy[${index}]`,
              ConditionExpression: conditions.join(' AND '),
              ExpressionAttributeValues: values,
            },
          },
          { Delete: { TableName: TABLE_NAME, Key: placeOwnershipKey(owner, place) } },
        ],
      }),
    );

    logger.info('Place ownership revoked', { id, owner, revokedBy: user.id });
    return json(200, { id, owner });
  } catch (error) {
    // ownerBy changed between the read and the write
    if (conditionFailedAt(error, 0)) return conflict('Place owners changed, try again');
    logger.error('Failed to revoke place ownership', error as Error);
    return serverError();
  }
};
