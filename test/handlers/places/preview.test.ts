import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/places/preview';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-preview', awsRequestId: 'test' } as Context;
const event = (id: string) => ({ pathParameters: { id } }) as unknown as APIGatewayProxyEvent;

const draftItem: PlaceItem = {
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
  website: '',
  status: PlaceStatus.DRAFT,
  reason: '',
  published: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('GET /places/{id}', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('returns a place regardless of published/status', async () => {
    ddbMock.on(GetCommand).resolves({ Item: draftItem });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).status).toBe(PlaceStatus.DRAFT);
  });

  it('returns 404 when missing', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event('missing'), context);
    expect(result.statusCode).toBe(404);
  });
});
