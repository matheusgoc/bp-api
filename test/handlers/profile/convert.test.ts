import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';

const resolveExternalId = jest.fn();
jest.mock('../../../src/lib/auth', () => ({
  resolveExternalId: (...args: unknown[]) => resolveExternalId(...args),
}));

import { handler } from '../../../src/handlers/profile/convert';
import { SubscriptionStatus, UserItem, UserRole } from '../../../src/models/user';

const ddbMock = mockClient(ddb);
const context = { functionName: 'profile-convert', awsRequestId: 'test' } as Context;
const event = (body: unknown) =>
  ({ body: JSON.stringify(body ?? {}), headers: {}, requestContext: {} }) as unknown as APIGatewayProxyEvent;

const makeUser = (overrides: Partial<UserItem>): UserItem => ({
  PK: 'USER#1',
  SK: 'METADATA',
  GSI1PK: 'USER#EXTERNAL#ext-1',
  GSI1SK: 'METADATA',
  id: '1',
  externalId: 'ext-1',
  name: 'Ana',
  email: 'ana@example.com',
  phone: '',
  isWhatsapp: false,
  dob: '',
  gender: '',
  role: UserRole.CUSTOMER,
  subscriptionStatus: SubscriptionStatus.NOT_APPLIED,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('PATCH /profile/convert', () => {
  beforeEach(() => {
    ddbMock.reset();
    resolveExternalId.mockReset();
  });

  it('self-converts a non-admin to owner, ignoring any id/type in the body', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const own = makeUser({});
    ddbMock.on(QueryCommand).resolves({ Items: [own] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...own, role: UserRole.OWNER } });

    const result = await handler(event({ id: 'someone-else', type: UserRole.ADMIN }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).role).toBe(UserRole.OWNER);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.Key).toEqual({ PK: 'USER#1', SK: 'METADATA' });
    expect(call.args[0].input.ExpressionAttributeValues?.[':role']).toBe(UserRole.OWNER);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('self-converts an admin who sends no id', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const own = makeUser({ role: UserRole.ADMIN });
    ddbMock.on(QueryCommand).resolves({ Items: [own] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...own, role: UserRole.OWNER } });

    const result = await handler(event({}), context);

    expect(result.statusCode).toBe(200);
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.Key).toEqual({ PK: 'USER#1', SK: 'METADATA' });
  });

  it('lets an admin convert another user, defaulting to owner', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const own = makeUser({ role: UserRole.ADMIN });
    ddbMock.on(QueryCommand).resolves({ Items: [own] });
    ddbMock.on(GetCommand).resolves({ Item: makeUser({ id: '2', PK: 'USER#2' }) });
    ddbMock
      .on(UpdateCommand)
      .resolves({ Attributes: makeUser({ id: '2', PK: 'USER#2', role: UserRole.OWNER }) });

    const result = await handler(event({ id: '2' }), context);

    expect(result.statusCode).toBe(200);
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.Key).toEqual({ PK: 'USER#2', SK: 'METADATA' });
    expect(call.args[0].input.ExpressionAttributeValues?.[':role']).toBe(UserRole.OWNER);
  });

  it('lets an admin convert another user to a given type', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const own = makeUser({ role: UserRole.ADMIN });
    ddbMock.on(QueryCommand).resolves({ Items: [own] });
    ddbMock.on(GetCommand).resolves({ Item: makeUser({ id: '2', PK: 'USER#2' }) });
    ddbMock
      .on(UpdateCommand)
      .resolves({ Attributes: makeUser({ id: '2', PK: 'USER#2', role: UserRole.ADMIN }) });

    const result = await handler(event({ id: '2', type: UserRole.ADMIN }), context);

    expect(result.statusCode).toBe(200);
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues?.[':role']).toBe(UserRole.ADMIN);
  });

  it('rejects an admin targeting their own id', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const own = makeUser({ role: UserRole.ADMIN });
    ddbMock.on(QueryCommand).resolves({ Items: [own] });

    const result = await handler(event({ id: '1' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('rejects an admin targeting a nonexistent user', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const own = makeUser({ role: UserRole.ADMIN });
    ddbMock.on(QueryCommand).resolves({ Items: [own] });
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event({ id: 'missing' }), context);

    expect(result.statusCode).toBe(404);
  });

  it('rejects an invalid type', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const own = makeUser({ role: UserRole.ADMIN });
    ddbMock.on(QueryCommand).resolves({ Items: [own] });
    ddbMock.on(GetCommand).resolves({ Item: makeUser({ id: '2', PK: 'USER#2' }) });

    const result = await handler(event({ id: '2', type: 'bogus' }), context);

    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the caller has no profile yet', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(event({}), context);
    expect(result.statusCode).toBe(404);
  });

  it('rejects when unauthorized', async () => {
    resolveExternalId.mockResolvedValue({ error: 'unauthorized' });
    const result = await handler(event({}), context);
    expect(result.statusCode).toBe(401);
  });
});
