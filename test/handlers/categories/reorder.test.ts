import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/categories/reorder';
import { CategoryItem } from '../../../src/models/category';

const ddbMock = mockClient(ddb);
const context = { functionName: 'categories-reorder', awsRequestId: 'test' } as Context;

const event = (body: unknown) =>
  ({ body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

const itemFor = (id: string, order: number): CategoryItem => ({
  PK: `CATEGORY#${id}`,
  SK: 'METADATA',
  GSI1PK: 'CATEGORY#ENABLED',
  GSI1SK: String(order).padStart(15, '0'),
  GSI2PK: 'CATEGORY',
  GSI2SK: String(order).padStart(15, '0'),
  id,
  name: 'X',
  description: '',
  enabled: true,
  order,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'seed',
  updatedAt: '2024-01-01T00:00:00.000Z',
});

describe('POST /categories/reorder', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('rewrites order to each id\'s index in the array', async () => {
    ddbMock
      .on(UpdateCommand)
      .callsFake((input) => ({
        Attributes: itemFor(input.Key.PK.replace('CATEGORY#', ''), input.ExpressionAttributeValues[':order']),
      }));

    const result = await handler(event(['b', 'a', 'c']), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.map((c: { id: string }) => c.id)).toEqual(['b', 'a', 'c']);
    expect(body.data.map((c: { order: number }) => c.order)).toEqual([0, 1, 2]);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0].input.ExpressionAttributeValues?.[':order']).toBe(0);
    expect(calls[1].args[0].input.ExpressionAttributeValues?.[':order']).toBe(1);
    expect(calls[2].args[0].input.ExpressionAttributeValues?.[':order']).toBe(2);
  });

  it('rejects an empty array', async () => {
    const result = await handler(event([]), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects duplicate ids', async () => {
    const result = await handler(event(['a', 'a']), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a non-array body', async () => {
    const result = await handler(event({ ids: ['a'] }), context);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when one of the ids does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event(['missing']), context);
    expect(result.statusCode).toBe(404);
  });
});
