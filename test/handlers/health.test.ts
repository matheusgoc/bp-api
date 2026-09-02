import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { handler } from '../../src/handlers/health';

describe('GET /health', () => {
  it('returns 200 with service status', async () => {
    const result = await handler(
      {} as APIGatewayProxyEvent,
      { functionName: 'health', awsRequestId: 'test' } as Context,
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('bp-api');
    expect(body.timestamp).toBeDefined();
  });
});
