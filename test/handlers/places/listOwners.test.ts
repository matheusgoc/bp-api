import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requirePlaceAccess = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requirePlaceAccess: (...args: unknown[]) => requirePlaceAccess(...args),
}));

import { handler } from '../../../src/handlers/places/listOwners';
import { UserRole } from '../../../src/models/user';
import { makePlace } from '../offers/fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-list-owners', awsRequestId: 'test' } as Context;

const event = (id: string) =>
  ({ pathParameters: { id }, requestContext: {} }) as unknown as APIGatewayProxyEvent;

const makeUser = (id: string, role: UserRole = UserRole.OWNER) => ({
  PK: `USER#${id}`,
  SK: 'METADATA',
  id,
  externalId: `ext-${id}`,
  name: `User ${id}`,
  email: `${id}@example.com`,
  phone: '61998887733',
  isWhatsapp: true,
  dob: '1990-01-01',
  gender: 'F',
  role,
  subscriptionStatus: 'not_applied',
});

const caller = { id: 'u1', role: UserRole.OWNER };

describe('GET /places/{id}/owners', () => {
  beforeEach(() => {
    ddbMock.reset();
    requirePlaceAccess.mockReset();
  });

  it("lists the place's other owners in ownerBy order, without the caller", async () => {
    const place = makePlace({ ownerBy: ['u3', 'u1', 'u2'] });
    requirePlaceAccess.mockResolvedValue({ user: caller, place });
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE_NAME]: [makeUser('u2'), makeUser('u3')] } });

    const result = await handler(event('p1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      data: [
        { id: 'u3', name: 'User u3', email: 'u3@example.com' },
        { id: 'u2', name: 'User u2', email: 'u2@example.com' },
      ],
    });
    expect(requirePlaceAccess).toHaveBeenCalledWith(expect.anything(), 'p1');

    const keys = ddbMock.commandCalls(BatchGetCommand)[0].args[0].input.RequestItems![TABLE_NAME].Keys;
    expect(keys).toEqual([
      { PK: 'USER#u3', SK: 'METADATA' },
      { PK: 'USER#u2', SK: 'METADATA' },
    ]);
  });

  it('skips missing profiles and users who can no longer manage the place', async () => {
    const place = makePlace({ ownerBy: ['u1', 'u2', 'u3', 'gone'] });
    requirePlaceAccess.mockResolvedValue({ user: caller, place });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { [TABLE_NAME]: [makeUser('u2', UserRole.CUSTOMER), makeUser('u3')] },
    });

    const result = await handler(event('p1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data.map((owner: { id: string }) => owner.id)).toEqual(['u3']);
  });

  it('lists every owner for an admin caller not listed in ownerBy', async () => {
    const place = makePlace({ ownerBy: ['u1', 'u2'] });
    requirePlaceAccess.mockResolvedValue({ user: { id: 'admin', role: UserRole.ADMIN }, place });
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE_NAME]: [makeUser('u1'), makeUser('u2')] } });

    const result = await handler(event('p1'), context);

    expect(JSON.parse(result.body).data.map((owner: { id: string }) => owner.id)).toEqual([
      'u1',
      'u2',
    ]);
  });

  it('returns an empty list without reading when the caller is the only owner', async () => {
    requirePlaceAccess.mockResolvedValue({ user: caller, place: makePlace({ ownerBy: ['u1'] }) });

    const result = await handler(event('p1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ data: [] });
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it('passes through the place access check response', async () => {
    requirePlaceAccess.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('p1'), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });
});
