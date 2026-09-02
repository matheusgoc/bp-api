import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/categories/preview';
import { CategoryItem } from '../../../src/models/category';

const ddbMock = mockClient(ddb);
const context = { functionName: 'categories-preview', awsRequestId: 'test' } as Context;
const event = (id: string) => ({ pathParameters: { id } }) as unknown as APIGatewayProxyEvent;

const disabledItem: CategoryItem = {
  PK: 'CATEGORY#1',
  SK: 'METADATA',
  GSI1SK: '2024-01-01T00:00:00.000Z',
  GSI2PK: 'CATEGORY',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: '1',
  name: 'X',
  description: '',
  enabled: false,
  order: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'seed',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('GET /categories/{id}', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('returns a category regardless of enabled', async () => {
    ddbMock.on(GetCommand).resolves({ Item: disabledItem });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).enabled).toBe(false);
  });

  it('returns 404 when missing', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event('missing'), context);
    expect(result.statusCode).toBe(404);
  });
});
