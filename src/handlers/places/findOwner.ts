import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requirePlaceAccess } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, conflict, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { toPlaceOwnerModel, userEmailKey, UserItem, UserRole } from '../../models/user';

interface FindOwnerDto {
  email?: unknown;
}

/**
 * Find Place Owner
 *
 * PATCH /places/{id}/owners/find (Cognito-protected, place owner/admin only)
 * Looks up one owner user by email, to grant them access to the place afterwards
 * (PATCH /places/{id}/grant). Only users with the owner role are searchable.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('PATH_PARAMETER_REQUIRED', 'id');

  let findOwnerDto: FindOwnerDto;
  try {
    findOwnerDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('INVALID_JSON');
  }

  const email = typeof findOwnerDto.email === 'string' ? findOwnerDto.email.trim() : '';
  if (!email) return badRequest('FIELD_REQUIRED', 'email');

  try {
    const access = await requirePlaceAccess(event, id);
    if ('response' in access) return access.response;
    const { place } = access;

    // the email index partition holds one profile per email, at most a few duplicates —
    // signup doesn't enforce uniqueness, so take the first one that's an owner
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': userEmailKey(email) },
      }),
    );
    const owner = (result.Items as UserItem[] | undefined)?.find(
      (item) => item.role === UserRole.OWNER,
    );
    if (!owner) return notFound('Owner not found');

    if ((place.ownerBy ?? []).includes(owner.id)) return conflict('User already owns this place');

    logger.info('Place owner found', { id, owner: owner.id });
    return json(200, toPlaceOwnerModel(owner));
  } catch (error) {
    logger.error('Failed to find place owner', error as Error);
    return serverError();
  }
};
