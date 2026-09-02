import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { categoryOrderSortKey, CategoryItem, toCategoryModel } from '../../models/category';

/**
 * Reorder Categories
 *
 * PATCH /categories/reorder (Cognito-protected)
 * body is a bare array of category ids, ordered first to last; rewrites each
 * one's "order" to its index in the array (0 = first)
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  let ids: unknown;
  try {
    ids = JSON.parse(event.body ?? '[]');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    return badRequest('Request body must be a non-empty array of category ids');
  }
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return badRequest('Request body must contain only non-empty strings');
  }
  if (new Set(ids).size !== ids.length) {
    return badRequest('Request body must not contain duplicate ids');
  }

  const updatedAt = new Date().toISOString();

  try {
    const results = await Promise.all(
      (ids as string[]).map((id, order) =>
        ddb.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: `CATEGORY#${id}`, SK: 'METADATA' },
            UpdateExpression: 'SET #order = :order, GSI1SK = :sk, GSI2SK = :sk, updatedAt = :updatedAt',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: { '#order': 'order' },
            ExpressionAttributeValues: {
              ':order': order,
              ':sk': categoryOrderSortKey(order),
              ':updatedAt': updatedAt,
            },
            ReturnValues: 'ALL_NEW',
          }),
        ),
      ),
    );

    const data = results.map((result) => toCategoryModel(result.Attributes as CategoryItem));

    logger.info('Categories reordered', { count: data.length });
    return json(200, { data });
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('One or more category ids do not exist');
    }
    logger.error('Failed to reorder categories', error as Error);
    return serverError();
  }
};
