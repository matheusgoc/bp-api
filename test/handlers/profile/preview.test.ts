import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';

const resolveExternalId = jest.fn();
jest.mock('../../../src/lib/auth', () => ({
  resolveExternalId: (...args: unknown[]) => resolveExternalId(...args),
}));

import { handler } from '../../../src/handlers/profile/preview';
import { SubscriptionStatus, UserItem, UserRole } from '../../../src/models/user';

const ddbMock = mockClient(ddb);
const context = { functionName: 'profile-preview', awsRequestId: 'test' } as Context;
const event = () => ({ headers: {}, requestContext: {} }) as unknown as APIGatewayProxyEvent;

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

describe('GET /profile', () => {
  beforeEach(() => {
    ddbMock.reset();
    resolveExternalId.mockReset();
  });

  it('returns the profile for the resolved externalId', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [item] });

    const result = await handler(event(), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).id).toBe('1');

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'USER#EXTERNAL#ext-1' });
  });

  it('returns 404 when no profile exists yet', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(event(), context);
    expect(result.statusCode).toBe(404);
  });

  it('rejects when unauthorized', async () => {
    resolveExternalId.mockResolvedValue({ error: 'unauthorized' });
    const result = await handler(event(), context);
    expect(result.statusCode).toBe(401);
  });
});
