import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../src/lib/dynamo';

const resolveExternalId = jest.fn();
jest.mock('../../src/lib/auth', () => ({
  resolveExternalId: (...args: unknown[]) => resolveExternalId(...args),
}));

import { requirePlaceAccess, requireRole } from '../../src/lib/access';
import { UserRole } from '../../src/models/user';

const ddbMock = mockClient(ddb);
const event = {} as APIGatewayProxyEvent;
const allowed = [UserRole.OWNER, UserRole.ADMIN];

describe('requireRole', () => {
  beforeEach(() => {
    ddbMock.reset();
    resolveExternalId.mockReset();
  });

  it('returns 401 when the caller cannot be identified', async () => {
    resolveExternalId.mockResolvedValue({ error: 'unauthorized' });

    const result = await requireRole(event, allowed);

    expect('response' in result && result.response.statusCode).toBe(401);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('returns 403 when the caller has no profile', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await requireRole(event, allowed);

    expect('response' in result && result.response.statusCode).toBe(403);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI1');
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'USER#EXTERNAL#ext-1' });
  });

  it('returns 403 when the caller role is not allowed', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: '1', role: UserRole.CUSTOMER }] });

    const result = await requireRole(event, allowed);

    expect('response' in result && result.response.statusCode).toBe(403);
  });

  it.each([UserRole.OWNER, UserRole.ADMIN])('returns the user when role is %s', async (role) => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: '1', role }] });

    const result = await requireRole(event, allowed);

    expect(result).toEqual({ user: { id: '1', role } });
  });
});

describe('requirePlaceAccess', () => {
  const place = { PK: 'PLACE#p1', SK: 'METADATA', id: 'p1', ownerBy: ['u1'] };

  beforeEach(() => {
    ddbMock.reset();
    resolveExternalId.mockReset();
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
  });

  it('passes through the role check response without reading the place', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: 'u1', role: UserRole.CUSTOMER }] });

    const result = await requirePlaceAccess(event, 'p1');

    expect('response' in result && result.response.statusCode).toBe(403);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: 'u1', role: UserRole.OWNER }] });
    ddbMock.on(GetCommand).resolves({});

    const result = await requirePlaceAccess(event, 'missing');

    expect('response' in result && result.response.statusCode).toBe(404);
    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call.args[0].input.Key).toEqual({ PK: 'PLACE#missing', SK: 'METADATA' });
  });

  it('returns 403 when the owner is not in ownerBy', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: 'u2', role: UserRole.OWNER }] });
    ddbMock.on(GetCommand).resolves({ Item: place });

    const result = await requirePlaceAccess(event, 'p1');

    expect('response' in result && result.response.statusCode).toBe(403);
  });

  it('returns the user and place for one of its owners', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: 'u1', role: UserRole.OWNER }] });
    ddbMock.on(GetCommand).resolves({ Item: place });

    const result = await requirePlaceAccess(event, 'p1');

    expect(result).toEqual({ user: { id: 'u1', role: UserRole.OWNER }, place });
  });

  it('lets an admin through even when not in ownerBy', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: 'a1', role: UserRole.ADMIN }] });
    ddbMock.on(GetCommand).resolves({ Item: place });

    const result = await requirePlaceAccess(event, 'p1');

    expect(result).toEqual({ user: { id: 'a1', role: UserRole.ADMIN }, place });
  });
});
