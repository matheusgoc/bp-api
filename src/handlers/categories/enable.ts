import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { CategoryItem, toCategoryModel } from '../../models/category';

/**
 * Enable Category
 * 
 * PATCH /categories/{id}/enable (Cognito-protected)
 * sets enabled=true and adds GSI1PK so the category appears in the public listing
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
        UpdateExpression: 'SET enabled = :true, GSI1PK = :gsi1pk, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':true': true,
          ':gsi1pk': 'CATEGORY#ENABLED',
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Category enabled', { id });
    return json(200, toCategoryModel(result.Attributes as CategoryItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Category not found');
    }
    logger.error('Failed to enable category', error as Error);
    return serverError();
  }
};
