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

import { handler } from '../../../src/handlers/places/revoke';
import { UserRole } from '../../../src/models/user';
import { makePlace } from '../offers/fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-revoke', awsRequestId: 'test' } as Context;

const event = (id: string, body: unknown) =>
  ({ pathParameters: { id }, body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

// u1 created the place and later granted u2
const place = makePlace({ ownerBy: ['u1', 'u2'], createdBy: 'u1' });

const transactItems = () => ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;

describe('PATCH /places/{id}/revoke', () => {
  beforeEach(() => {
    ddbMock.reset();
    requirePlaceAccess.mockReset();
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER }, place });
  });

  it('removes the owner from ownerBy and deletes their ownership index item in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event('p1', { owner: 'u2' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: 'p1', owner: 'u2' });
    expect(requirePlaceAccess).toHaveBeenCalledWith(expect.anything(), 'p1');
    // membership in ownerBy is enough, the target user isn't looked up
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);

    const [update, ownership] = transactItems();
    expect(update.Update?.Key).toEqual({ PK: 'PLACE#p1', SK: 'METADATA' });
    expect(update.Update?.UpdateExpression).toContain('REMOVE ownerBy[1]');
    expect(update.Update?.ConditionExpression).toContain('ownerBy[1] = :owner');
    expect(update.Update?.ConditionExpression).toContain('contains(ownerBy, :caller)');
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({ ':owner': 'u2', ':caller': 'u1' });
    expect(ownership.Delete?.Key).toEqual({ PK: 'USER#u2', SK: `PLACE#${place.createdAt}#p1` });
  });

  it('lets an admin revoke the place creator, without the caller ownership condition', async () => {
    requirePlaceAccess.mockResolvedValue({ user: { id: 'admin', role: UserRole.ADMIN }, place });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event('p1', { owner: 'u1' }), context);

    expect(result.statusCode).toBe(200);
    const [update, ownership] = transactItems();
    expect(update.Update?.UpdateExpression).toContain('REMOVE ownerBy[0]');
    expect(update.Update?.ConditionExpression).toBe('ownerBy[0] = :owner');
    expect(update.Update?.ExpressionAttributeValues).not.toHaveProperty(':caller');
    expect(ownership.Delete?.Key).toEqual({ PK: 'USER#u1', SK: `PLACE#${place.createdAt}#p1` });
  });

  it.each([{}, { owner: '  ' }, { owner: 42 }])('returns 400 for a missing owner %#', async (body) => {
    const result = await handler(event('p1', body), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      code: 'FIELD_REQUIRED',
      field: 'owner',
      msg: '"owner" is required',
    });
    expect(requirePlaceAccess).not.toHaveBeenCalled();
  });

  it('passes through the place access check response', async () => {
    requirePlaceAccess.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('p1', { owner: 'u2' }), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 400 when the caller revokes themselves', async () => {
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u2', role: UserRole.OWNER }, place });

    const result = await handler(event('p1', { owner: 'u2' }), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ code: 'CANNOT_REVOKE_SELF', field: 'owner' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 404 when the user does not own the place', async () => {
    const result = await handler(event('p1', { owner: 'u3' }), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('User does not own this place');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 403 when an owner tries to revoke the place creator', async () => {
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u2', role: UserRole.OWNER }, place });

    const result = await handler(event('p1', { owner: 'u1' }), context);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error).toBe('Only an admin can revoke the place creator');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 409 when the place owners changed concurrently', async () => {
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
});
