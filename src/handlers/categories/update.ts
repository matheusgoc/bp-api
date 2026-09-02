import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { CategoryItem, toCategoryModel } from '../../models/category';

interface CategoryDto {
  name?: string;
  description?: string;
}

const EDITABLE_FIELDS: Array<keyof CategoryDto> = ['name', 'description'];

/**
 * Update Category
 * 
 * PUT /categories/{id} (Cognito-protected)
 * update category name and description
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  let categoryDto: CategoryDto;
  try {
    categoryDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  for (const field of EDITABLE_FIELDS) {
    const value = categoryDto[field];
    if (value === undefined) continue;
    if (!value.trim()) return badRequest(`"${field}" cannot be empty`);

    names[`#${field}`] = field;
    values[`:${field}`] = value.trim();
    sets.push(`#${field} = :${field}`);
  }

  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();
  sets.push('#updatedAt = :updatedAt');

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CATEGORY#${id}`, SK: 'METADATA' },
        UpdateExpression: `SET ${sets.join(', ')}`, // [{#name = :name}, {#description = :description}, {#updatedAt = :updatedAt}]
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: names, // { '#name': 'name', '#description': 'description', '#updatedAt': 'updatedAt' }
        ExpressionAttributeValues: values, // { ':name': value, ':description': value, ':updatedAt': value }
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Category updated', { id });
    return json(200, toCategoryModel(result.Attributes as CategoryItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Category not found');
    }
    logger.error('Failed to update category', error as Error);
    return serverError();
  }
};
