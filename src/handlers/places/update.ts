import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceItem, PlaceStatus, toPlaceModel } from '../../models/place';

interface PlaceDto {
  name?: string;
  description?: string;
  category?: string;
  website?: string;
}

const FIELDS: (keyof PlaceDto)[] = ['name', 'description', 'category', 'website'];

/**
 * Update Place
 * 
 * PUT /places/{id} (Cognito-protected)
 * every successful update pushes status to reviewing
 * published flag remains untouched
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  let placeDto: PlaceDto;
  try {
    placeDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  for (const field of FIELDS) {
    const value = placeDto[field];
    if (value === undefined) continue;
    if (!value.trim()) return badRequest(`"${field}" cannot be empty`);

    const attribute = field;
    names[`#${attribute}`] = field;
    values[`:${attribute}`] = value.trim();
    sets.push(`#${field} = :${field}`);
  }

  names['#status'] = 'status';
  values[':status'] = PlaceStatus.REVIEWING;
  sets.push('#status = :status');

  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();
  sets.push('#updatedAt = :updatedAt');

  try {
    if (placeDto.category !== undefined) {
      const categoryResult = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: `CATEGORY#${placeDto.category.trim()}`, SK: 'METADATA' },
        }),
      );
      if (!categoryResult.Item) {
        return badRequest('"category" does not exists');
      }
    }

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PLACE#${id}`, SK: 'METADATA' },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Place updated', { id });
    return json(200, toPlaceModel(result.Attributes as PlaceItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Place not found');
    }
    logger.error('Failed to update place', error as Error);
    return serverError();
  }
};
