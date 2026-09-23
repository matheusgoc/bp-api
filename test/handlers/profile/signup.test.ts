import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';

const resolveExternalId = jest.fn();
jest.mock('../../../src/lib/auth', () => ({
  resolveExternalId: (...args: unknown[]) => resolveExternalId(...args),
}));

// Imported after the mock above so the handler picks up the mocked resolveExternalId.
import { handler } from '../../../src/handlers/profile/signup';
import { SubscriptionStatus, UserRole } from '../../../src/models/user';

const ddbMock = mockClient(ddb);
const context = { functionName: 'profile-signup', awsRequestId: 'test' } as Context;

const event = (body: unknown) =>
  ({ body: JSON.stringify(body), headers: {}, requestContext: {} }) as unknown as APIGatewayProxyEvent;

describe('POST /profile', () => {
  beforeEach(() => {
    ddbMock.reset();
    resolveExternalId.mockReset();
  });

  it('creates a profile for a new externalId, defaulting role/subscriptionStatus/isWhatsapp', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(event({ name: 'Ana', email: 'ana@example.com' }), context);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('Ana');
    expect(body.email).toBe('ana@example.com');
    expect(body.role).toBe(UserRole.CUSTOMER);
    expect(body.subscriptionStatus).toBe(SubscriptionStatus.NOT_APPLIED);
    expect(body.isWhatsapp).toBe(false);

    const putCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putCall.args[0].input.Item?.externalId).toBe('ext-1');
    expect(putCall.args[0].input.Item?.GSI1PK).toBe('USER#EXTERNAL#ext-1');
  });

  it('accepts phone/isWhatsapp/dob/gender', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-2' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(
      event({
        name: 'Bea',
        email: 'bea@example.com',
        phone: '123',
        isWhatsapp: true,
        dob: '1990-01-01',
        gender: 'F',
      }),
      context,
    );

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.phone).toBe('123');
    expect(body.isWhatsapp).toBe(true);
    expect(body.dob).toBe('1990-01-01');
    expect(body.gender).toBe('F');
  });

  it('rejects a missing name', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const result = await handler(event({ email: 'a@a.com' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a missing email', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const result = await handler(event({ name: 'Ana' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects an invalid gender', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const result = await handler(event({ name: 'Ana', email: 'a@a.com', gender: 'X' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a non-boolean isWhatsapp', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    const result = await handler(
      event({ name: 'Ana', email: 'a@a.com', isWhatsapp: 'yes' }),
      context,
    );
    expect(result.statusCode).toBe(400);
  });

  it('rejects when unauthorized', async () => {
    resolveExternalId.mockResolvedValue({ error: 'unauthorized' });
    const result = await handler(event({ name: 'Ana', email: 'a@a.com' }), context);
    expect(result.statusCode).toBe(401);
  });

  it('rejects a duplicate profile for the same externalId', async () => {
    resolveExternalId.mockResolvedValue({ externalId: 'ext-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'USER#1' }] });

    const result = await handler(event({ name: 'Ana', email: 'a@a.com' }), context);

    expect(result.statusCode).toBe(409);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
