import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { resolveExternalId } from './auth';
import { ddb, TABLE_NAME } from './dynamo';
import { forbidden, unauthorized } from './http';
import { UserItem, UserRole, userExternalIdKey } from '../models/user';

export type RequireRoleResult = { user: UserItem } | { response: APIGatewayProxyResult };

// Resolves the caller's app-level profile (via the GSI1 externalId lookup) and checks its role. 
// 401 when the caller can't be identified, 403 when they have no profile or their role isn't one of `roles`.
export const requireRole = async (
  event: APIGatewayProxyEvent,
  roles: UserRole[],
): Promise<RequireRoleResult> => {
  const auth = await resolveExternalId(event);
  if ('error' in auth) return { response: unauthorized() };

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': userExternalIdKey(auth.externalId) },
      Limit: 1,
    }),
  );

  const user = result.Items?.[0] as UserItem | undefined;
  if (!user) return { response: forbidden('Profile not found') };
  if (!roles.includes(user.role)) {
    return { response: forbidden(`Requires one of the roles: ${roles.join(', ')}`) };
  }

  return { user };
};
