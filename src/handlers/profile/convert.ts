import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { resolveExternalId } from '../../lib/auth';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError, unauthorized } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { UserItem, UserRole, toUserModel, userExternalIdKey } from '../../models/user';

interface ConvertDto {
  id?: string;
  type?: UserRole;
}

const VALID_ROLES = Object.values(UserRole);

/**
 * Convert Profile
 *
 * PATCH /profile/convert (Cognito-protected)
 * Converts the current user to 'owner'. If the current user is an admin and
 * passes another user's id in the body, that user's role is changed instead
 * (defaulting to 'owner', or the given "type").
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const auth = await resolveExternalId(event);
  if ('error' in auth) return unauthorized();
  const { externalId } = auth;

  let convertDto: ConvertDto;
  try {
    convertDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  try {
    const ownResult = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': userExternalIdKey(externalId) },
        Limit: 1,
      }),
    );

    const own = ownResult.Items?.[0] as UserItem | undefined;
    if (!own) return notFound('Profile not found');

    const targetId = own.role === UserRole.ADMIN ? convertDto.id?.trim() : undefined;

    let targetKey = { PK: own.PK, SK: own.SK };
    let targetRole: UserRole = UserRole.OWNER;

    if (targetId) {
      if (targetId === own.id) {
        return badRequest('"id" must be another user, not the current one');
      }

      const targetResult = await ddb.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USER#${targetId}`, SK: 'METADATA' } }),
      );
      if (!targetResult.Item) return notFound('User not found');

      if (convertDto.type !== undefined) {
        if (!VALID_ROLES.includes(convertDto.type)) {
          return badRequest(`"type" must be one of: ${VALID_ROLES.join(', ')}`);
        }
        targetRole = convertDto.type;
      }

      targetKey = { PK: `USER#${targetId}`, SK: 'METADATA' };
    }

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: targetKey,
        UpdateExpression: 'SET #role = :role, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: {
          ':role': targetRole,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Profile converted', { id: targetKey.PK, role: targetRole });
    return json(200, toUserModel(result.Attributes as UserItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Profile not found');
    }
    logger.error('Failed to convert profile', error as Error);
    return serverError();
  }
};
