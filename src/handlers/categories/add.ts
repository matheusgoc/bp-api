import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, serverError } from '../../lib/http';
import { logger, metrics } from '../../lib/powertools';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { categoryOrderSortKey, CategoryItem, toCategoryModel } from '../../models/category';

interface CategoryDto {
  name: string;
  description: string;
}

/**
 * Add Category
 *
 * POST /categories (Cognito-protected)
 * creates a category, enabled by default
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  let categoryDto: CategoryDto;
  try {
    categoryDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (!categoryDto.name?.trim()) return badRequest('"name" is required');
  if (!categoryDto.description?.trim()) return badRequest('"description" is required');

  const createdBy =
    event.requestContext.authorizer?.claims?.sub ?? 'local-dev';

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  
  // default new categories to the end of the list
  const order = Date.now();
  const orderSortKey = categoryOrderSortKey(order);

  const item: CategoryItem = {
    PK: `CATEGORY#${id}`,
    SK: 'METADATA',
    GSI1PK: 'CATEGORY#ENABLED',
    GSI1SK: orderSortKey,
    GSI2PK: 'CATEGORY',
    GSI2SK: orderSortKey,
    id,
    name: categoryDto.name.trim(),
    description: categoryDto.description?.trim() ?? '',
    enabled: true,
    order,
    createdAt,
    createdBy,
    updatedAt: createdAt,
  };

  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

    metrics.addMetric('CategoryCreated', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    logger.info('Category created', { id });

    return json(201, toCategoryModel(item));
  } catch (error) {
    logger.error('Failed to create category', error as Error);
    return serverError();
  }
};
