import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/categories/add';

const ddbMock = mockClient(ddb);
const context = { functionName: 'categories-add', awsRequestId: 'test' } as Context;

const event = (body: unknown) =>
  ({ body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

describe('POST /categories', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('creates a category enabled by default', async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(
      event({ name: 'Alimentação e Bebidas', description: 'Restaurante, bar, padaria' }),
      context,
    );

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('Alimentação e Bebidas');
    expect(body.description).toBe('Restaurante, bar, padaria');
    expect(body.enabled).toBe(true);

    const putCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putCall.args[0].input.Item?.GSI1PK).toBe('CATEGORY#ENABLED');
  });

  it('rejects a missing name', async () => {
    const result = await handler(event({ description: 'x' }), context);
    expect(result.statusCode).toBe(400);
  });
});
