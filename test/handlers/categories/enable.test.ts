import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/categories/enable';
import { CategoryItem } from '../../../src/models/category';

const ddbMock = mockClient(ddb);
const context = { functionName: 'categories-enable', awsRequestId: 'test' } as Context;
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

describe('POST /categories/{id}/enable', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('enables a category and sets GSI1PK', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...disabledItem, enabled: true, GSI1PK: 'CATEGORY#ENABLED' },
    });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).enabled).toBe(true);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues?.[':gsi1pk']).toBe('CATEGORY#ENABLED');
  });

  it('returns 404 when the category does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('missing'), context);
    expect(result.statusCode).toBe(404);
  });
});
