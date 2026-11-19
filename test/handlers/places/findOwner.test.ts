import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requirePlaceAccess = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requirePlaceAccess: (...args: unknown[]) => requirePlaceAccess(...args),
}));

import { handler } from '../../../src/handlers/places/findOwner';
import { UserRole } from '../../../src/models/user';
import { makePlace } from '../offers/fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-find-owner', awsRequestId: 'test' } as Context;

const event = (id: string, body: unknown) =>
  ({ pathParameters: { id }, body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

const place = makePlace({ ownerBy: ['u1'] });
const makeUser = (id: string, role: UserRole) => ({
  PK: `USER#${id}`,
  SK: 'METADATA',
  GSI2PK: 'USER#EMAIL#ana@example.com',
  GSI2SK: 'METADATA',
  id,
  externalId: `ext-${id}`,
  name: 'Ana',
  email: 'Ana@Example.com',
  phone: '61998887733',
  isWhatsapp: true,
  dob: '1990-01-01',
  gender: 'F',
  role,
  subscriptionStatus: 'not_applied',
});

describe('PATCH /places/{id}/owners/find', () => {
  beforeEach(() => {
    ddbMock.reset();
    requirePlaceAccess.mockReset();
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER }, place });
  });

  it('finds the owner by normalized email through the GSI2 email index', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeUser('u2', UserRole.OWNER)] });

    const result = await handler(event('p1', { email: '  Ana@Example.com ' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: 'u2', name: 'Ana', email: 'Ana@Example.com' });
    expect(requirePlaceAccess).toHaveBeenCalledWith(expect.anything(), 'p1');

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.IndexName).toBe('GSI2');
    expect(query.KeyConditionExpression).toBe('GSI2PK = :pk');
    expect(query.ExpressionAttributeValues).toEqual({ ':pk': 'USER#EMAIL#ana@example.com' });
  });

  it.each([{}, { email: '  ' }, { email: 42 }])('returns 400 for a missing email %#', async (body) => {
    const result = await handler(event('p1', body), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      code: 'FIELD_REQUIRED',
      field: 'email',
      msg: '"email" is required',
    });
    expect(requirePlaceAccess).not.toHaveBeenCalled();
  });

  it('passes through the place access check response', async () => {
    requirePlaceAccess.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('p1', { email: 'ana@example.com' }), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('returns 404 when no user has the email', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(event('p1', { email: 'nobody@example.com' }), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Owner not found');
  });

  it.each([UserRole.CUSTOMER, UserRole.ADMIN])(
    'returns 404 when the user with the email is a %s',
    async (role) => {
      ddbMock.on(QueryCommand).resolves({ Items: [makeUser('u2', role)] });

      const result = await handler(event('p1', { email: 'ana@example.com' }), context);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toBe('Owner not found');
    },
  );

  it('picks the owner among profiles sharing the email', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeUser('u3', UserRole.CUSTOMER), makeUser('u2', UserRole.OWNER)],
    });

    const result = await handler(event('p1', { email: 'ana@example.com' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).id).toBe('u2');
  });

  it('returns 409 when the owner already owns the place', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeUser('u1', UserRole.OWNER)] });

    const result = await handler(event('p1', { email: 'ana@example.com' }), context);

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toBe('User already owns this place');
  });
});
