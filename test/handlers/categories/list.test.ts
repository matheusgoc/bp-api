import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/categories/list';
import { CategoryItem } from '../../../src/models/category';

const ddbMock = mockClient(ddb);
const context = { functionName: 'categories-list', awsRequestId: 'test' } as Context;

const eventWith = (queryStringParameters: Record<string, string> | null) =>
  ({ queryStringParameters, headers: {} }) as unknown as APIGatewayProxyEvent;

const item: CategoryItem = {
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

describe('GET /categories', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('defaults to querying GSI1 for enabled categories and maps them to CategoryModel', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [item] });

    const result = await handler(eventWith(null), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data[0].id).toBe('1');
    expect(body.meta).toBeUndefined();

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI1');
    expect(call.args[0].input.ExpressionAttributeValues?.[':pk']).toBe('CATEGORY#ENABLED');
  });

  it('rejects an invalid "enabled" value', async () => {
    const result = await handler(eventWith({ enabled: 'nope' }), context);
    expect(result.statusCode).toBe(400);
  });

  it.each(['false', 'all'])(
    'allows ?enabled=%s with no Authorization header (fully public list)',
    async (enabled) => {
      ddbMock.on(QueryCommand).resolves({ Items: [item] });

      const result = await handler(eventWith({ enabled }), context);

      expect(result.statusCode).toBe(200);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    },
  );

  it('queries GSI2 with no filter for ?enabled=all', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [item, { ...item, enabled: false }] });

    const result = await handler(eventWith({ enabled: 'all' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toHaveLength(2);

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI2');
    expect(call.args[0].input.FilterExpression).toBeUndefined();
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'CATEGORY' });
  });

  it('queries GSI2 with an enabled=false filter for ?enabled=false', async () => {
    const disabled = { ...item, enabled: false };
    ddbMock.on(QueryCommand).resolves({ Items: [disabled] });

    const result = await handler(eventWith({ enabled: 'false' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toHaveLength(1);

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI2');
    expect(call.args[0].input.FilterExpression).toBe('enabled = :enabled');
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'CATEGORY',
      ':enabled': false,
    });
  });
});
