import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/places/preview';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';
import { makeLocation } from '../locations/fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-preview', awsRequestId: 'test' } as Context;
const event = (id: string, query?: Record<string, string>) =>
  ({ pathParameters: { id }, queryStringParameters: query ?? null }) as unknown as APIGatewayProxyEvent;

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
  draftPhoto: '',
  draftLogo: '',
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

  it('returns a place regardless of published/status, with empty locations', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [draftItem] });

    const result = await handler(event('1'), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe(PlaceStatus.DRAFT);
    expect(body.locations).toEqual([]);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'PLACE#1',
    });
  });

  it('includes active locations sorted by createdAt and hides soft-deleted ones', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeLocation({ PK: 'PLACE#1', SK: 'LOCATION#b', id: 'b', createdAt: '2024-02-01T00:00:00.000Z' }),
        makeLocation({ PK: 'PLACE#1', SK: 'LOCATION#c', id: 'c', deleted: true }),
        makeLocation({ PK: 'PLACE#1', SK: 'LOCATION#a', id: 'a', createdAt: '2024-01-15T00:00:00.000Z' }),
        draftItem,
      ],
    });

    const result = await handler(event('1'), context);

    const { locations } = JSON.parse(result.body);
    expect(locations.map((l: { id: string }) => l.id)).toEqual(['a', 'b']);
    expect(locations[0].deleted).toBeUndefined();
  });

  it('includes soft-deleted locations flagged as deleted with ?deleted=true', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [draftItem, makeLocation({ PK: 'PLACE#1', SK: 'LOCATION#c', id: 'c', deleted: true })],
    });

    const result = await handler(event('1', { deleted: 'true' }), context);

    const { locations } = JSON.parse(result.body);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ id: 'c', deleted: true });
  });

  it('follows pagination across the place partition', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [draftItem], LastEvaluatedKey: { PK: 'PLACE#1', SK: 'METADATA' } })
      .resolvesOnce({ Items: [makeLocation({ PK: 'PLACE#1', SK: 'LOCATION#a', id: 'a' })] });

    const result = await handler(event('1'), context);

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(JSON.parse(result.body).locations).toHaveLength(1);
  });

  it('returns 404 when the place METADATA item is missing', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(event('missing'), context);
    expect(result.statusCode).toBe(404);
  });
});
