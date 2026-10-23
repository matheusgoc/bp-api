import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { resolveExternalId } from './auth';
import { ddb, TABLE_NAME } from './dynamo';
import { forbidden, notFound, unauthorized } from './http';
import { canManagePlace, PLACE_ACCESS_DENIED, PlaceItem } from '../models/place';
import { UserItem, UserRole, userExternalIdKey } from '../models/user';

export type RequireRoleResult = { user: UserItem } | { response: APIGatewayProxyResult };
export type RequirePlaceAccessResult =
  | { user: UserItem; place: PlaceItem }
  | { response: APIGatewayProxyResult };

// The caller's app-level profile, looked up by their Cognito sub through the GSI1 externalId index.
export const findUserByExternalId = async (externalId: string): Promise<UserItem | undefined> => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': userExternalIdKey(externalId) },
      Limit: 1,
    }),
  );
  return result.Items?.[0] as UserItem | undefined;
};

// Resolves the caller's app-level profile (via the GSI1 externalId lookup) and checks its role
// 401 when the caller can't be identified, 403 when they have no profile or their role isn't one of `roles`
export const requireRole = async (
  event: APIGatewayProxyEvent,
  roles: UserRole[],
): Promise<RequireRoleResult> => {
  const auth = await resolveExternalId(event);
  if ('error' in auth) return { response: unauthorized() };

  const user = await findUserByExternalId(auth.externalId);
  if (!user) return { response: forbidden('Profile not found') };
  if (!roles.includes(user.role)) {
    return { response: forbidden(`Requires one of the roles: ${roles.join(', ')}`) };
  }

  return { user };
};

// requireRole for owner/admin, plus the place ownership check
// the gate for every endpoint managing a place, its locations or offers
// 404 when the place doesn't exist, 403 unless
// the caller is an admin or listed in the place's ownerBy
export const requirePlaceAccess = async (
  event: APIGatewayProxyEvent,
  placeId: string,
): Promise<RequirePlaceAccessResult> => {
  const access = await requireRole(event, [UserRole.OWNER, UserRole.ADMIN]);
  if ('response' in access) return access;

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PLACE#${placeId}`, SK: 'METADATA' } }),
  );

  const place = result.Item as PlaceItem | undefined;
  if (!place) return { response: notFound('Place not found') };
  if (!canManagePlace(access.user, place)) return { response: forbidden(PLACE_ACCESS_DENIED) };

  return { user: access.user, place };
};
