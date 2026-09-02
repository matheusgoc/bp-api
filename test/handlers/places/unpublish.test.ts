import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
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
  website: '',
  status: PlaceStatus.REVIEWING,
  reason: '',
  published: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('POST /places/{id}/unpublish', () => {
  beforeEach(() => {
    ddbMock.reset();
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
});
