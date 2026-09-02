import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

const verify = jest.fn();
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify }) },
}));

// Imported after the mock above so the handler's module-scoped verifier picks it up.
import { handler } from '../../../src/handlers/places/list';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-list', awsRequestId: 'test' } as Context;

const eventWith = (
  queryStringParameters: Record<string, string> | null,
  authorization?: string,
) =>
  ({
    queryStringParameters,
    headers: authorization ? { Authorization: authorization } : {},
  }) as unknown as APIGatewayProxyEvent;

const encodeCursor = (filter: 'true' | 'false' | 'all', key: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ filter, key })).toString('base64url');

const item: PlaceItem = {
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
  status: PlaceStatus.ACTIVE,
  reason: '',
  published: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('GET /places', () => {
  beforeEach(() => {
    ddbMock.reset();
    verify.mockReset();
  });

  it('defaults to querying GSI1 for published places and maps them to PlaceModel', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [item] });

    const result = await handler(eventWith(null), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data[0].id).toBe('1');
    expect(body.data[0].category).toEqual({ id: 'cat-1' });
    expect(body.meta).toEqual({
      take: 20,
      hasPreviousPage: false,
      hasNextPage: false,
      nextCursor: null,
    });

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI1');
    expect(call.args[0].input.Limit).toBe(20);
    expect(call.args[0].input.ExclusiveStartKey).toBeUndefined();
    expect(call.args[0].input.ExpressionAttributeValues?.[':pk']).toBe('PLACE#PUBLISHED');
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects an invalid "published" value', async () => {
    const result = await handler(eventWith({ published: 'nope' }), context);
    expect(result.statusCode).toBe(400);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects an invalid "take" value %s', async (take) => {
    const result = await handler(eventWith({ take }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a "take" above the max', async () => {
    const result = await handler(eventWith({ take: '101' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a malformed "cursor"', async () => {
    const result = await handler(eventWith({ cursor: 'not-valid-base64url-json' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('rejects a cursor minted for a different "published" filter', async () => {
    verify.mockResolvedValue({ sub: 'user-1' });
    const cursor = encodeCursor('true', { PK: 'PLACE#1', SK: 'METADATA' });

    const result = await handler(
      eventWith({ published: 'all', cursor }, 'Bearer good-token'),
      context,
    );

    expect(result.statusCode).toBe(400);
  });

  it('passes take as Limit and returns a nextCursor when more results exist', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [item],
      LastEvaluatedKey: { PK: 'PLACE#1', SK: 'METADATA', GSI1PK: 'PLACE#PUBLISHED', GSI1SK: 'x' },
    });

    const result = await handler(eventWith({ take: '1' }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.meta.hasNextPage).toBe(true);
    expect(typeof body.meta.nextCursor).toBe('string');

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.Limit).toBe(1);
  });

  it('resumes from a decoded cursor and reports hasPreviousPage', async () => {
    const lastEvaluatedKey = { PK: 'PLACE#1', SK: 'METADATA', GSI1PK: 'PLACE#PUBLISHED', GSI1SK: 'x' };
    const cursor = encodeCursor('true', lastEvaluatedKey);
    ddbMock.on(QueryCommand).resolves({ Items: [item] });

    const result = await handler(eventWith({ cursor }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.meta.hasPreviousPage).toBe(true);
    expect(body.meta.hasNextPage).toBe(false);
    expect(body.meta.nextCursor).toBeNull();

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });

  it.each(['false', 'all'])(
    'rejects ?published=%s with no Authorization header',
    async (published) => {
      const result = await handler(eventWith({ published }), context);
      expect(result.statusCode).toBe(401);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    },
  );

  it.each(['false', 'all'])('rejects ?published=%s with an invalid token', async (published) => {
    verify.mockRejectedValue(new Error('invalid token'));

    const result = await handler(eventWith({ published }, 'Bearer bad-token'), context);

    expect(result.statusCode).toBe(401);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('queries GSI2 with no filter for ?published=all with a valid token', async () => {
    verify.mockResolvedValue({ sub: 'user-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [item, { ...item, published: false }] });

    const result = await handler(eventWith({ published: 'all' }, 'Bearer good-token'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toHaveLength(2);

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI2');
    expect(call.args[0].input.FilterExpression).toBeUndefined();
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'PLACE' });
  });

  it('queries GSI2 with a published=false filter for ?published=false with a valid token', async () => {
    verify.mockResolvedValue({ sub: 'user-1' });
    const unpublished = { ...item, published: false };
    ddbMock.on(QueryCommand).resolves({ Items: [unpublished] });

    const result = await handler(eventWith({ published: 'false' }, 'Bearer good-token'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toHaveLength(1);

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI2');
    expect(call.args[0].input.FilterExpression).toBe('published = :published');
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'PLACE',
      ':published': false,
    });
  });
});
