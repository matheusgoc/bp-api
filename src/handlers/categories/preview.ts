import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { CategoryItem, toCategoryModel } from '../../models/category';

/**
 * Preview Category
 *
 * GET /categories/{id}
 * shows category data
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
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CATEGORY#${id}`, SK: 'METADATA' } }),
    );

    if (!result.Item) return notFound('Category not found');

    return json(200, toCategoryModel(result.Item as CategoryItem));
  } catch (error) {
    logger.error('Failed to preview category', error as Error);
    return serverError();
  }
};
