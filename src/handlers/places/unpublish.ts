import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requirePlaceAccess } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceItem, toPlaceModel } from '../../models/place';

/**
 * Unpublish Place
 * 
 * PATCH /places/{id}/unpublish (Cognito-protected, place owner/admin only)
 * sets published=false
 * removes GSI1PK so the place drops out of the public listing.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  try {
    const access = await requirePlaceAccess(event, id);
    if ('response' in access) return access.response;

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PLACE#${id}`, SK: 'METADATA' },
        UpdateExpression: 'SET published = :false, updatedAt = :updatedAt REMOVE GSI1PK',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':false': false,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Place unpublished', { id });
    return json(200, toPlaceModel(result.Attributes as PlaceItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Place not found');
    }
    logger.error('Failed to unpublish place', error as Error);
    return serverError();
  }
};
