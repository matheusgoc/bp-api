import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceItem, PlaceStatus, toPlaceModel } from '../../models/place';
import { UserRole } from '../../models/user';

interface ReviewDto {
  status?: PlaceStatus;
}

/**
 * Review Place
 *
 * PATCH /places/{id}/review (Cognito-protected, admin only)
 * change place status — admin-only so an owner can't approve (and then publish) their own place
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  let reviewDto: ReviewDto;
  try {
    reviewDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const availableStatuses = Object.values(PlaceStatus);
  if (!reviewDto.status || !availableStatuses.includes(reviewDto.status)) {
    return badRequest(`"status" must be one of: ${availableStatuses.join(', ')}`);
  }

  try {
    const access = await requireRole(event, [UserRole.ADMIN]);
    if ('response' in access) return access.response;

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PLACE#${id}`, SK: 'METADATA' },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': reviewDto.status,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Place reviewed', { id, status: reviewDto.status });
    return json(200, toPlaceModel(result.Attributes as PlaceItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Place not found');
    }
    logger.error('Failed to review place', error as Error);
    return serverError();
  }
};
