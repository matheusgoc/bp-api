import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requirePlaceAccess } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceItem, PlaceStatus, toPlaceModel } from '../../models/place';

/**
 * Publish Place
 * 
 * PATCH /places/{id}/publish (Cognito-protected, place owner/admin only)
 * only allowed when the place's current status is ACTIVE 
 * sets published=true and adds GSI1PK so the place appears in the public listing.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  const key = { PK: `PLACE#${id}`, SK: 'METADATA' };

  try {
    const access = await requirePlaceAccess(event, id);
    if ('response' in access) return access.response;

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'SET published = :true, GSI1PK = :gsi1pk, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK) AND #status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':true': true,
          ':gsi1pk': 'PLACE#PUBLISHED',
          ':updatedAt': new Date().toISOString(),
          ':active': PlaceStatus.ACTIVE,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Place published', { id });
    return json(200, toPlaceModel(result.Attributes as PlaceItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const existing = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
      if (!existing.Item) return notFound('Place not found');
      return badRequest('Place must be approved (status "active") before it can be published');
    }
    logger.error('Failed to publish place', error as Error);
    return serverError();
  }
};
