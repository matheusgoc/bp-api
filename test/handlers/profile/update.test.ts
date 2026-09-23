import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';

const resolveExternalId = jest.fn();
jest.mock('../../../src/lib/auth', () => ({
  resolveExternalId: (...args: unknown[]) => resolveExternalId(...args),
}));

import { handler } from '../../../src/handlers/profile/update';
import { SubscriptionStatus, UserItem, UserRole } from '../../../src/models/user';

const ddbMock = mockClient(ddb);
const context = { functionName: 'profile-update', awsRequestId: 'test' } as Context;
const event = (body: unknown) =>
  ({ body: JSON.stringify(body), headers: {}, requestContext: {} }) as unknown as APIGatewayProxyEvent;

const item: UserItem = {
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
};

describe('PUT /profile', () => {
  beforeEach(() => {
    ddbMock.reset();
    resolveExternalId.mockReset();
  });

  it('updates allowed string fields, keyed on the resolved profile', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [item] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...item, name: 'Ana Updated' } });

    const result = await handler(event({ name: 'Ana Updated' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).name).toBe('Ana Updated');

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.Key).toEqual({ PK: 'USER#1', SK: 'METADATA' });
  });

  it('updates isWhatsapp and an empty-string gender', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [item] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...item, isWhatsapp: true, gender: '' } });

    const result = await handler(event({ isWhatsapp: true, gender: '' }), context);

    expect(result.statusCode).toBe(200);
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues?.[':isWhatsapp']).toBe(true);
    expect(call.args[0].input.ExpressionAttributeValues?.[':gender']).toBe('');
  });

  it('rejects an empty name', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const result = await handler(event({ name: '  ' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects an invalid gender', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const result = await handler(event({ gender: 'X' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a non-boolean isWhatsapp', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const result = await handler(event({ isWhatsapp: 'yes' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when no profile exists yet', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(event({ name: 'X' }), context);
    expect(result.statusCode).toBe(404);
  });

  it('rejects when unauthorized', async () => {
    resolveExternalId.mockResolvedValue({ error: 'unauthorized' });
    const result = await handler(event({ name: 'X' }), context);
    expect(result.statusCode).toBe(401);
  });
});
