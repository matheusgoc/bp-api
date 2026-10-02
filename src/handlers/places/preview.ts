import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { LOCATION_SK_PREFIX, LocationItem, toLocationModel } from '../../models/location';
import { PlaceItem, toPlaceModel } from '../../models/place';

// GET /places/{id}[?deleted=true]
// soft-deleted locations are only included with ?deleted=true.
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  const includeDeleted = event.queryStringParameters?.deleted === 'true';

  try {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `PLACE#${id}` },
          ExclusiveStartKey,
        }),
      );
      items.push(...(result.Items ?? []));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const place = items.find((item) => item.SK === 'METADATA') as PlaceItem | undefined;
    if (!place) return notFound('Place not found');

    const locations = (
      items.filter((item) => String(item.SK).startsWith(LOCATION_SK_PREFIX)) as unknown as LocationItem[]
    )
      .filter((location) => includeDeleted || !location.deleted)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toLocationModel);

    return json(200, toPlaceModel(place, locations));
  } catch (error) {
    logger.error('Failed to preview place', error as Error);
    return serverError();
  }
};
