import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, serverError } from '../../lib/http';
import { logger, metrics } from '../../lib/powertools';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { PlaceItem, PlaceStatus, toPlaceModel } from '../../models/place';

interface PlaceDto {
  name: string;
  description: string;
  category: string;
  website: string;
}

/**
 * Add Place
 * 
 * POST /places (Cognito-protected)
 * Creates a place in DRAFT status, unpublished
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  let placeDto: PlaceDto;
  try {
    placeDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (!placeDto.name?.trim()) return badRequest('"name" is required');
  if (!placeDto.category?.trim()) return badRequest('"category" is required');

  const category = placeDto.category.trim();

  const createdBy =
    event.requestContext.authorizer?.claims?.sub ?? 'local-dev';

  const id = randomUUID();
  const createdAt = new Date().toISOString();

  try {
    const categoryResult = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CATEGORY#${category}`, SK: 'METADATA' },
      }),
    );
    if (!categoryResult.Item) {
      return badRequest('"category" does not exists');
    }

    const item: PlaceItem = {
      PK: `PLACE#${id}`,
      SK: 'METADATA',
      GSI1SK: createdAt,
      GSI2PK: 'PLACE',
      GSI2SK: createdAt,
      id,
      name: placeDto.name.trim(),
      description: placeDto.description?.trim() ?? '',
      category,
      photo: '',
      logo: '',
      website: placeDto.website?.trim() ?? '',
      status: PlaceStatus.DRAFT,
      reason: '',
      published: false,
      createdAt,
      createdBy,
      updatedAt: createdAt,
    };

    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

    metrics.addMetric('PlaceCreated', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    logger.info('Place created', { id });

    return json(201, toPlaceModel(item));
  } catch (error) {
    logger.error('Failed to create place', error as Error);
    return serverError();
  }
};
