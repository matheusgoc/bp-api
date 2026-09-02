import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { json } from '../lib/http';
import { logger } from '../lib/powertools';

export const handler = async (
  _event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);
  logger.info('Health check');

  return json(200, {
    status: 'ok',
    service: 'bp-api',
    timestamp: new Date().toISOString(),
  });
};
