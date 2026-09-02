import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceItem, toPlaceModel } from '../../models/place';

// GET /places/{id}
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  try {
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PLACE#${id}`, SK: 'METADATA' } }),
    );

    if (!result.Item) return notFound('Place not found');

    return json(200, toPlaceModel(result.Item as PlaceItem));
  } catch (error) {
    logger.error('Failed to preview place', error as Error);
    return serverError();
  }
};
