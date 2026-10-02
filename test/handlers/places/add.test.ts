import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/places/add';
import { PlaceStatus } from '../../../src/models/place';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-add', awsRequestId: 'test' } as Context;

const event = (body: unknown) =>
  ({ body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

describe('POST /places', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('creates a place in draft status, unpublished, with no locations and empty offers', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'CATEGORY#cat-1', SK: 'METADATA' } });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(
      event({ name: 'Pizzaria do Bairro', category: 'cat-1' }),
      context,
    );

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('Pizzaria do Bairro');
    expect(body.category).toEqual({ id: 'cat-1' });
    expect(body.status).toBe(PlaceStatus.DRAFT);
    expect(body.published).toBe(false);
    expect(body.locations).toBeUndefined();
    expect(body.offers).toEqual([]);

    const getCall = ddbMock.commandCalls(GetCommand)[0];
    expect(getCall.args[0].input.Key).toEqual({ PK: 'CATEGORY#cat-1', SK: 'METADATA' });

    const putCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putCall.args[0].input.Item?.GSI1PK).toBeUndefined();
  });

  it('rejects a missing name', async () => {
    const result = await handler(event({ category: 'cat-1' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a missing category', async () => {
    const result = await handler(event({ name: 'X' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a category that does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event({ name: 'X', category: 'missing' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
