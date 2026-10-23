import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requirePlaceAccess = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requirePlaceAccess: (...args: unknown[]) => requirePlaceAccess(...args),
}));

import { handler } from '../../../src/handlers/places/grant';
import { UserRole } from '../../../src/models/user';
import { makePlace } from '../offers/fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-grant', awsRequestId: 'test' } as Context;

const event = (id: string, body: unknown) =>
  ({ pathParameters: { id }, body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

const place = makePlace({ ownerBy: ['u1'] });
const targetUser = { PK: 'USER#u2', SK: 'METADATA', id: 'u2', role: UserRole.OWNER };

describe('PATCH /places/{id}/grant', () => {
  beforeEach(() => {
    ddbMock.reset();
    requirePlaceAccess.mockReset();
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER }, place });
  });

  it('adds the owner to ownerBy and writes their ownership index item in one transaction', async () => {
    ddbMock.on(GetCommand).resolves({ Item: targetUser });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event('p1', { owner: 'u2' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: 'p1', owner: 'u2' });
    expect(requirePlaceAccess).toHaveBeenCalledWith(expect.anything(), 'p1');

    const getCall = ddbMock.commandCalls(GetCommand)[0];
    expect(getCall.args[0].input.Key).toEqual({ PK: 'USER#u2', SK: 'METADATA' });

    const [update, ownership] =
      ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(update.Update?.Key).toEqual({ PK: 'PLACE#p1', SK: 'METADATA' });
    expect(update.Update?.UpdateExpression).toContain('list_append(if_not_exists(ownerBy, :empty), :owners)');
    expect(update.Update?.ConditionExpression).toContain('NOT contains(ownerBy, :owner)');
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({ ':owners': ['u2'], ':owner': 'u2' });
    expect(ownership.Put?.Item).toMatchObject({
      PK: 'USER#u2',
      SK: `PLACE#${place.createdAt}#p1`,
      placeId: 'p1',
      userId: 'u2',
      createdBy: 'u1',
    });
  });

  it.each([{}, { owner: '  ' }, { owner: 42 }])('returns 400 for a missing owner %#', async (body) => {
    const result = await handler(event('p1', body), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('"owner" is required');
    expect(requirePlaceAccess).not.toHaveBeenCalled();
  });

  it('passes through the place access check response', async () => {
    requirePlaceAccess.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('p1', { owner: 'u2' }), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 409 when the user already owns the place', async () => {
    const result = await handler(event('p1', { owner: 'u1' }), context);

    expect(result.statusCode).toBe(409);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 409 when a concurrent grant added the same owner first', async () => {
    ddbMock.on(GetCommand).resolves({ Item: targetUser });
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );

    const result = await handler(event('p1', { owner: 'u2' }), context);

    expect(result.statusCode).toBe(409);
  });

  it('returns 404 when the user does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event('p1', { owner: 'missing' }), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('User not found');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([UserRole.CUSTOMER, UserRole.ADMIN])('returns 400 when the user is a %s', async (role) => {
    ddbMock.on(GetCommand).resolves({ Item: { ...targetUser, role } });

    const result = await handler(event('p1', { owner: 'u2' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
