import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { findUserByExternalId } from '../../lib/access';
import { resolveExternalId } from '../../lib/auth';
import { batchGetAll, ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, forbidden, json, serverError, unauthorized } from '../../lib/http';
import { decodeCursor, encodeCursor, parseTake } from '../../lib/pagination';
import { logger } from '../../lib/powertools';
import {
  canManagePlace,
  PLACE_OWNERSHIP_SK_PREFIX,
  PlaceItem,
  PlaceOwnershipItem,
  toPlaceModel,
} from '../../models/place';
import { UserItem, UserRole } from '../../models/user';

type PublishedFilter = 'true' | 'false' | 'all';
const VALID_FILTERS: PublishedFilter[] = ['true', 'false', 'all'];

const isLocal = !!process.env.DYNAMODB_ENDPOINT;

const jwtVerifier = isLocal
  ? undefined
  : CognitoJwtVerifier.create({
      userPoolId: process.env.USER_POOL_ID ?? '',
      tokenUse: 'id',
      clientId: process.env.USER_POOL_CLIENT_ID ?? '',
    });

// The caller's Cognito sub
// this route has no Gateway authorizer, so the token is verified here against the user pool 
// under SAM local there's no pool to verify against, so it falls back to resolveExternalId's unverified decode 
// undefined when the caller can't be identified
const resolveCaller = async (event: APIGatewayProxyEvent): Promise<string | undefined> => {
  if (isLocal) {
    const auth = await resolveExternalId(event);
    return 'error' in auth ? undefined : auth.externalId;
  }

  const header = event.headers?.Authorization ?? event.headers?.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return undefined;

  try {
    const payload = await jwtVerifier!.verify(token);
    return payload.sub;
  } catch {
    return undefined;
  }
};

interface Page {
  items: PlaceItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

// List all published places
const listPlaces = async (
  filter: PublishedFilter,
  take: number,
  exclusiveStartKey?: Record<string, unknown>,
): Promise<Page> => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: filter === 'true' ? 'GSI1' : 'GSI2',
      KeyConditionExpression: filter === 'true' ? 'GSI1PK = :pk' : 'GSI2PK = :pk',
      FilterExpression: filter === 'false' ? 'published = :published' : undefined,
      ExpressionAttributeValues:
        filter === 'true'
          ? { ':pk': 'PLACE#PUBLISHED' }
          : filter === 'false'
            ? { ':pk': 'PLACE', ':published': false }
            : { ':pk': 'PLACE' },
      ScanIndexForward: false, // newest first
      Limit: take,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  return { items: (result.Items ?? []) as PlaceItem[], lastEvaluatedKey: result.LastEvaluatedKey };
};

// List places the owner has access to
const listOwnedPlaces = async (
  owner: UserItem,
  filter: PublishedFilter,
  take: number,
  exclusiveStartKey?: Record<string, unknown>,
): Promise<Page> => {
  const items: PlaceItem[] = [];
  let startKey = exclusiveStartKey;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `USER#${owner.id}`, ':prefix': PLACE_OWNERSHIP_SK_PREFIX },
        ScanIndexForward: false, // newest first
        Limit: take,
        ExclusiveStartKey: startKey,
      }),
    );

    const ownerships = (result.Items ?? []) as PlaceOwnershipItem[];
    const places = ownerships.length
      ? ((await batchGetAll(
          ownerships.map((ownership) => ({ PK: `PLACE#${ownership.placeId}`, SK: 'METADATA' })),
        )) as unknown as PlaceItem[])
      : [];

    // BatchGetItem doesn't keep the request order
    const placesById = new Map(places.map((place) => [place.id, place]));

    for (const [index, ownership] of ownerships.entries()) {
      const place = placesById.get(ownership.placeId);
      const visible =
        !!place &&
        canManagePlace(owner, place) &&
        (filter === 'all' || place.published === (filter === 'true'));
      if (visible) items.push(place);

      if (items.length === take) {
        const exhausted = index === ownerships.length - 1 && !result.LastEvaluatedKey;
        return {
          items,
          lastEvaluatedKey: exhausted ? undefined : { PK: ownership.PK, SK: ownership.SK },
        };
      }
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return { items };
};

/**
 * list places
 *
 * GET /places
 * ?published=true (default) — public | every published place
 * ?published=false|all — unpublished-only or every place | owner/admin only, verified in-handler;
 *   an admin lists every place, an owner only the places whose ownerBy lists them
 * ?take (default 20, capped at 100)
 * ?cursor — cursor-based pagination
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const parsedTake = parseTake(event.queryStringParameters?.take);
  if ('error' in parsedTake) return badRequest(parsedTake.error);
  const { take } = parsedTake;

  const filter = (event.queryStringParameters?.published ?? 'true') as PublishedFilter;
  if (!VALID_FILTERS.includes(filter)) {
    return badRequest('"published" must be one of "true", "false", "all"');
  }

  const cursorParam = event.queryStringParameters?.cursor;

  try {
    // published places are open to everyone; unpublished ones only to their owners and admins
    let owner: UserItem | undefined;
    if (filter !== 'true') {
      const externalId = await resolveCaller(event);
      if (!externalId) {
        return unauthorized('A valid Cognito token is required to list unpublished places');
      }

      const user = await findUserByExternalId(externalId);
      if (!user) return forbidden('Profile not found');
      if (user.role !== UserRole.OWNER && user.role !== UserRole.ADMIN) {
        return forbidden(`Requires one of the roles: ${UserRole.OWNER}, ${UserRole.ADMIN}`);
      }

      if (user.role === UserRole.OWNER) owner = user;
    }

    // a cursor is only valid for the exact listing it was issued for — an owner's is tied to them
    const cursorTag = owner ? `${filter}#OWNER#${owner.id}` : filter;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (cursorParam) {
      exclusiveStartKey = decodeCursor(cursorParam, cursorTag);
      if (!exclusiveStartKey) return badRequest('"cursor" is invalid');
    }

    const page = owner
      ? await listOwnedPlaces(owner, filter, take, exclusiveStartKey)
      : await listPlaces(filter, take, exclusiveStartKey);

    const data = page.items.map((item) => toPlaceModel(item));
    const nextCursor = page.lastEvaluatedKey
      ? encodeCursor(cursorTag, page.lastEvaluatedKey)
      : null;

    logger.info('Places listed', {
      count: data.length,
      take,
      filter,
      owner: owner?.id,
      hasNextPage: !!nextCursor,
    });
    return json(200, {
      data,
      meta: {
        take,
        hasPreviousPage: !!cursorParam,
        hasNextPage: !!nextCursor,
        nextCursor,
      },
    });
  } catch (error) {
    logger.error('Failed to list places', error as Error);
    return serverError();
  }
};
