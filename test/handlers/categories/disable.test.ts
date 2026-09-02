import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/categories/disable';
import { CategoryItem } from '../../../src/models/category';

const ddbMock = mockClient(ddb);
const context = { functionName: 'categories-disable', awsRequestId: 'test' } as Context;
const event = (id: string) => ({ pathParameters: { id } }) as unknown as APIGatewayProxyEvent;

const enabledItem: CategoryItem = {
  PK: 'CATEGORY#1',
  SK: 'METADATA',
  GSI1PK: 'CATEGORY#ENABLED',
  GSI1SK: '2024-01-01T00:00:00.000Z',
  GSI2PK: 'CATEGORY',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: '1',
  name: 'X',
  description: '',
  enabled: true,
  order: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'seed',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('POST /categories/{id}/disable', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('disables regardless of prior state', async () => {
    const { GSI1PK: _GSI1PK, ...rest } = enabledItem;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...rest, enabled: false } });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).enabled).toBe(false);
  });

  it('returns 404 when the category does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('missing'), context);
    expect(result.statusCode).toBe(404);
  });
});
