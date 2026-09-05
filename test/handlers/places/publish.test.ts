import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/places/publish';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-publish', awsRequestId: 'test' } as Context;
const event = (id: string) => ({ pathParameters: { id } }) as unknown as APIGatewayProxyEvent;

const activeItem: PlaceItem = {
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
  status: PlaceStatus.ACTIVE,
  reason: '',
  published: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('POST /places/{id}/publish', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('publishes a place when status is active', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...activeItem, published: true, GSI1PK: 'PLACE#PUBLISHED' },
    });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).published).toBe(true);
  });

  it('returns 400 when the place is not active', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));
    ddbMock.on(GetCommand).resolves({ Item: { ...activeItem, status: PlaceStatus.DRAFT } });

    const result = await handler(event('1'), context);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event('missing'), context);
    expect(result.statusCode).toBe(404);
  });
});
