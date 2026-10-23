import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/places/add';
import { PlaceStatus } from '../../../src/models/place';
import { UserRole } from '../../../src/models/user';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-add', awsRequestId: 'test' } as Context;

const event = (body: unknown) =>
  ({ body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

describe('POST /places', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
  });

  it('creates a place in draft status, unpublished, with no locations or offers', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'CATEGORY#cat-1', SK: 'METADATA' } });
    ddbMock.on(TransactWriteCommand).resolves({});

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
    expect(body.offers).toBeUndefined();
    expect(body.ownerBy).toBeUndefined();

    expect(requireRole).toHaveBeenCalledWith(expect.anything(), [UserRole.OWNER, UserRole.ADMIN]);

    const getCall = ddbMock.commandCalls(GetCommand)[0];
    expect(getCall.args[0].input.Key).toEqual({ PK: 'CATEGORY#cat-1', SK: 'METADATA' });

    const [place] = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(place.Put?.Item?.GSI1PK).toBeUndefined();
  });

  it('makes the caller the owner, writing the ownership index item in the same transaction', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'CATEGORY#cat-1', SK: 'METADATA' } });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event({ name: 'X', category: 'cat-1' }), context);

    const { id } = JSON.parse(result.body);
    const [place, ownership] =
      ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    const item = place.Put?.Item;
    expect(item).toMatchObject({ PK: `PLACE#${id}`, ownerBy: ['u1'], createdBy: 'u1' });
    expect(ownership.Put?.Item).toEqual({
      PK: 'USER#u1',
      SK: `PLACE#${item?.createdAt}#${id}`,
      placeId: id,
      userId: 'u1',
      createdAt: item?.createdAt,
      createdBy: 'u1',
    });
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event({ name: 'X', category: 'cat-1' }), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
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
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
