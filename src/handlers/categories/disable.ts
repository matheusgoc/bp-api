import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { CategoryItem, toCategoryModel } from '../../models/category';

/**
 * Disable Category
 * 
 * PATCH /categories/{id}/disable (Cognito-protected)
 * sets enabled=false and removes GSI1PK so the category drops out of the public listing
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CATEGORY#${id}`, SK: 'METADATA' },
        UpdateExpression: 'SET enabled = :false, updatedAt = :updatedAt REMOVE GSI1PK',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':false': false,
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Category disabled', { id });
    return json(200, toCategoryModel(result.Attributes as CategoryItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Category not found');
    }
    logger.error('Failed to disable category', error as Error);
    return serverError();
  }
};
