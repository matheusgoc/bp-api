import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/categories/update';
import { CategoryItem } from '../../../src/models/category';

const ddbMock = mockClient(ddb);
const context = { functionName: 'categories-update', awsRequestId: 'test' } as Context;

const baseItem: CategoryItem = {
  PK: 'CATEGORY#1',
  SK: 'METADATA',
  GSI1PK: 'CATEGORY#ENABLED',
  GSI1SK: '2024-01-01T00:00:00.000Z',
  GSI2PK: 'CATEGORY',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: '1',
  name: 'Old name',
  description: '',
  enabled: true,
  order: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'seed',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const event = (id: string, body: unknown) =>
  ({ pathParameters: { id }, body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

describe('PUT /categories/{id}', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('merges only editable fields, leaving enabled untouched', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...baseItem, name: 'New name' },
    });

    const result = await handler(event('1', { name: 'New name' }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('New name');
    expect(body.enabled).toBe(true);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues?.[':name']).toBe('New name');
  });

  it('ignores an enabled field present in the body', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: baseItem });

    await handler(event('1', { enabled: false }), context);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const names = Object.values(call.args[0].input.ExpressionAttributeNames ?? {});
    expect(names).not.toContain('enabled');
  });

  it('returns 404 when the category does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('missing', { name: 'X' }), context);
    expect(result.statusCode).toBe(404);
  });

  it('rejects an empty string for an editable field', async () => {
    const result = await handler(event('1', { name: '  ' }), context);
    expect(result.statusCode).toBe(400);
  });
});
