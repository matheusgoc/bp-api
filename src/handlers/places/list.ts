import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, serverError, unauthorized } from '../../lib/http';
import { decodeCursor, encodeCursor, parseTake } from '../../lib/pagination';
import { logger } from '../../lib/powertools';
import { PlaceItem, toPlaceModel } from '../../models/place';

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

// verifies token against the Cognito user pool
const requireAuthenticated = async (event: APIGatewayProxyEvent): Promise<boolean> => {
  if (isLocal) return true;

  const header = event.headers?.Authorization ?? event.headers?.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return false;

  try {
    await jwtVerifier!.verify(token);
    return true;
  } catch {
    return false;
  }
};

/**
 * list places
 * 
 * GET /places
 * ?published=true (default) — public | published places only
 * ?published=false|all — unpublished-only or every place | requires a valid Cognito JWT.
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

  if (filter !== 'true' && !(await requireAuthenticated(event))) {
    return unauthorized('A valid Cognito token is required to list unpublished places');
  }

  const cursorParam = event.queryStringParameters?.cursor;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursorParam) {
    exclusiveStartKey = decodeCursor(cursorParam, filter);
    if (!exclusiveStartKey) return badRequest('"cursor" is invalid');
  }

  try {
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

    const data = ((result.Items ?? []) as PlaceItem[]).map((item) => toPlaceModel(item));
    const nextCursor = result.LastEvaluatedKey
      ? encodeCursor(filter, result.LastEvaluatedKey)
      : null;

    logger.info('Places listed', { count: data.length, take, filter, hasNextPage: !!nextCursor });
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
