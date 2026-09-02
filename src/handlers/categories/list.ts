import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { CategoryItem, toCategoryModel } from '../../models/category';

type EnabledFilter = 'true' | 'false' | 'all';
const VALID_FILTERS: EnabledFilter[] = ['true', 'false', 'all'];

/**
 * List Categories
 *
 * GET /categories
 * list all categories and make it fully public available
 * ?enabled=true (default) | false | all
 * sorted ascending by "order" (GSI1SK/GSI2SK hold a zero-padded encoding of it)
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const filter = (event.queryStringParameters?.enabled ?? 'true') as EnabledFilter;
  if (!VALID_FILTERS.includes(filter)) {
    return badRequest('"enabled" must be one of "true", "false", "all"');
  }

  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: filter === 'true' ? 'GSI1' : 'GSI2',
        KeyConditionExpression: filter === 'true' ? 'GSI1PK = :pk' : 'GSI2PK = :pk',
        FilterExpression: filter === 'false' ? 'enabled = :enabled' : undefined,
        ExpressionAttributeValues:
          filter === 'true'
            ? { ':pk': 'CATEGORY#ENABLED' }
            : filter === 'false'
              ? { ':pk': 'CATEGORY', ':enabled': false }
              : { ':pk': 'CATEGORY' },
        ScanIndexForward: true, // ascending by order
      }),
    );

    const data = ((result.Items ?? []) as CategoryItem[]).map(toCategoryModel);

    logger.info('Categories listed', { count: data.length, filter });
    return json(200, { data });
  } catch (error) {
    logger.error('Failed to list categories', error as Error);
    return serverError();
  }
};
