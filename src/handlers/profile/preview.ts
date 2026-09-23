import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { resolveExternalId } from '../../lib/auth';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { json, notFound, serverError, unauthorized } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { UserItem, toUserModel, userExternalIdKey } from '../../models/user';

/**
 * Preview Profile
 *
 * GET /profile (Cognito-protected)
 * Shows the current user's own profile.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const auth = await resolveExternalId(event);
  if ('error' in auth) return unauthorized();
  const { externalId } = auth;

  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': userExternalIdKey(externalId) },
        Limit: 1,
      }),
    );

    const item = result.Items?.[0] as UserItem | undefined;
    if (!item) return notFound('Profile not found');

    return json(200, toUserModel(item));
  } catch (error) {
    logger.error('Failed to preview profile', error as Error);
    return serverError();
  }
};
