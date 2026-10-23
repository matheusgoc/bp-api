import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';
import { UserRole } from '../../../src/models/user';

const requirePlaceAccess = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requirePlaceAccess: (...args: unknown[]) => requirePlaceAccess(...args),
}));
import { handler } from '../../../src/handlers/places/unpublish';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-unpublish', awsRequestId: 'test' } as Context;
const event = (id: string) => ({ pathParameters: { id } }) as unknown as APIGatewayProxyEvent;

const publishedItem: PlaceItem = {
  PK: 'PLACE#1',
  SK: 'METADATA',
  GSI1PK: 'PLACE#PUBLISHED',
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
  published: true,
  ownerBy: ['u1'],
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('POST /places/{id}/unpublish', () => {
  beforeEach(() => {
    ddbMock.reset();
    requirePlaceAccess.mockReset();
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER }, place: publishedItem });
  });

  it('unpublishes regardless of status', async () => {
    const { GSI1PK: _GSI1PK, ...rest } = publishedItem;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...rest, published: false } });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).published).toBe(false);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('missing'), context);
    expect(result.statusCode).toBe(404);
  });

  it('passes through the place access check response', async () => {
    requirePlaceAccess.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(403);
    expect(requirePlaceAccess).toHaveBeenCalledWith(expect.anything(), '1');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
