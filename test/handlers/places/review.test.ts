import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';
import { UserRole } from '../../../src/models/user';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));
import { handler } from '../../../src/handlers/places/review';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-review', awsRequestId: 'test' } as Context;

const baseItem: PlaceItem = {
  PK: 'PLACE#1',
  SK: 'METADATA',
  GSI1SK: '2024-01-01T00:00:00.000Z',
  GSI2PK: 'PLACE',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: '1',
  name: 'X',
  description: '',
  category: 'cat-1',
  photo: 'p',
  logo: '',
  draftPhoto: '',
  draftLogo: '',
  website: '',
  status: PlaceStatus.REVIEWING,
  reason: '',
  published: false,
  ownerBy: ['u1'],
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const event = (id: string, body: unknown) =>
  ({ pathParameters: { id }, body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

describe('POST /places/{id}/review', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'admin-1', role: UserRole.ADMIN } });
  });

  it('sets status to the given value', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...baseItem, status: PlaceStatus.ACTIVE } });

    const result = await handler(event('1', { status: PlaceStatus.ACTIVE }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).status).toBe(PlaceStatus.ACTIVE);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues?.[':status']).toBe(PlaceStatus.ACTIVE);
  });

  it('rejects a status outside the PlaceStatus enum', async () => {
    const result = await handler(event('1', { status: 'not-a-status' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('rejects a missing status', async () => {
    const result = await handler(event('1', {}), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('missing', { status: PlaceStatus.ACTIVE }), context);
    expect(result.statusCode).toBe(404);
  });

  it('requires the admin role', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('1', { status: PlaceStatus.ACTIVE }), context);

    expect(result.statusCode).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(expect.anything(), [UserRole.ADMIN]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
