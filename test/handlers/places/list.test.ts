import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../../src/lib/dynamo';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';
import { UserRole } from '../../../src/models/user';

const verify = jest.fn();
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify }) },
}));

const findUserByExternalId = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  findUserByExternalId: (...args: unknown[]) => findUserByExternalId(...args),
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

const encodeCursor = (filter: string, key: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ filter, key })).toString('base64url');

const decodeCursorFilter = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).filter;

const decodeCursorKey = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).key;

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
  draftPhoto: '',
  draftLogo: '',
  website: '',
  status: PlaceStatus.ACTIVE,
  reason: '',
  published: true,
  ownerBy: ['u1'],
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// a place and the caller's (u1) ownership index item pointing at it
const owned = (
  id: string,
  published: boolean,
  ownerBy = ['u1'],
): [PlaceItem, Record<string, unknown>] => [
  { ...item, PK: `PLACE#${id}`, id, published, ownerBy },
  { PK: 'USER#u1', SK: `PLACE#2024-01-01T00:00:00.000Z#${id}`, placeId: id, userId: 'u1' },
];

const ownerCaller = { id: 'u1', role: UserRole.OWNER };

const ownershipQuery = { KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)' };

describe('GET /places', () => {
  beforeEach(() => {
    ddbMock.reset();
    verify.mockReset();
    findUserByExternalId.mockReset();
    findUserByExternalId.mockResolvedValue({ id: 'admin-1', role: UserRole.ADMIN });
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

  it('queries GSI2 with no filter for ?published=all from an admin', async () => {
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

  it('queries GSI2 with a published=false filter for ?published=false from an admin', async () => {
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

  it('looks up the caller profile by the verified token sub', async () => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(eventWith({ published: 'all' }, 'Bearer good-token'), context);

    expect(findUserByExternalId).toHaveBeenCalledWith('sub-1');
  });

  it.each([
    ['no profile', undefined],
    ['a customer role', { id: 'u1', role: UserRole.CUSTOMER }],
  ])('returns 403 for ?published=all when the caller has %s', async (_, user) => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    findUserByExternalId.mockResolvedValue(user);

    const result = await handler(eventWith({ published: 'all' }, 'Bearer good-token'), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('lists every published place for an owner too, publicly', async () => {
    findUserByExternalId.mockResolvedValue(ownerCaller);
    ddbMock.on(QueryCommand).resolves({ Items: [item] });

    const result = await handler(eventWith(null, 'Bearer good-token'), context);

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.IndexName).toBe('GSI1');
    expect(verify).not.toHaveBeenCalled();
    expect(findUserByExternalId).not.toHaveBeenCalled();
  });

  it.each([
    ['all', ['p1', 'p2']],
    ['false', ['p2']],
  ])('lists only the places whose ownerBy lists an owner caller for ?published=%s', async (published, ids) => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    findUserByExternalId.mockResolvedValue(ownerCaller);
    const [p1, o1] = owned('p1', true);
    const [p2, o2] = owned('p2', false);
    // an index item whose place no longer lists the caller is dropped
    const [p3, o3] = owned('p3', false, ['u2']);
    ddbMock.on(QueryCommand, ownershipQuery).resolves({ Items: [o1, o2, o3] });
    // BatchGetItem returns items in no particular order
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [TABLE_NAME]: [p3, p2, p1] } });

    const result = await handler(eventWith({ published }, 'Bearer good-token'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data.map((place: { id: string }) => place.id)).toEqual(ids);

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.IndexName).toBeUndefined();
    expect(query.ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1', ':prefix': 'PLACE#' });
    expect(query.ScanIndexForward).toBe(false);
    expect(query.Limit).toBe(20);

    const batch = ddbMock.commandCalls(BatchGetCommand)[0].args[0].input;
    expect(batch.RequestItems?.[TABLE_NAME].Keys).toEqual([
      { PK: 'PLACE#p1', SK: 'METADATA' },
      { PK: 'PLACE#p2', SK: 'METADATA' },
      { PK: 'PLACE#p3', SK: 'METADATA' },
    ]);
  });

  it('skips the place fetch when an owner caller has no places', async () => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    findUserByExternalId.mockResolvedValue(ownerCaller);
    ddbMock.on(QueryCommand, ownershipQuery).resolves({ Items: [] });

    const result = await handler(eventWith({ published: 'all' }, 'Bearer good-token'), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toEqual([]);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it("tags an owner caller's cursor with their id and resumes from it", async () => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    findUserByExternalId.mockResolvedValue(ownerCaller);
    const lastEvaluatedKey = { PK: 'USER#u1', SK: 'PLACE#2024-01-01T00:00:00.000Z#p1' };
    const [p1, o1] = owned('p1', false);
    ddbMock.on(QueryCommand, ownershipQuery).resolves({ Items: [o1], LastEvaluatedKey: lastEvaluatedKey });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [TABLE_NAME]: [p1] } });

    const first = JSON.parse(
      (await handler(eventWith({ published: 'all', take: '1' }, 'Bearer good-token'), context)).body,
    );
    expect(decodeCursorFilter(first.meta.nextCursor)).toBe('all#OWNER#u1');

    await handler(
      eventWith({ published: 'all', cursor: first.meta.nextCursor }, 'Bearer good-token'),
      context,
    );
    expect(ddbMock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });

  it.each([
    ['another owner', encodeCursor('all#OWNER#u2', { PK: 'USER#u2', SK: 'PLACE#x' })],
    ['an admin', encodeCursor('all', { PK: 'PLACE#1', SK: 'METADATA' })],
  ])("rejects an owner caller's cursor minted for %s", async (_, cursor) => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    findUserByExternalId.mockResolvedValue(ownerCaller);

    const result = await handler(eventWith({ published: 'all', cursor }, 'Bearer good-token'), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  // BatchGetCommand answers whatever keys it's asked for, from the given places
  const batchGetFrom = (places: PlaceItem[]) => (input: { RequestItems?: Record<string, { Keys?: Record<string, unknown>[] }> }) => ({
    Responses: {
      [TABLE_NAME]: (input.RequestItems?.[TABLE_NAME]?.Keys ?? []).map((key) =>
        places.find((place) => place.PK === key.PK),
      ),
    },
  });

  it('keeps reading the owner caller\'s items until the page is full, so filtered-out places never leave it short', async () => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    findUserByExternalId.mockResolvedValue(ownerCaller);
    const [p1, o1] = owned('p1', true);
    const [p2, o2] = owned('p2', true);
    const [p3, o3] = owned('p3', false);
    const [p4, o4] = owned('p4', true);
    const [p5, o5] = owned('p5', false);
    ddbMock
      .on(QueryCommand, ownershipQuery)
      .resolvesOnce({ Items: [o1, o2], LastEvaluatedKey: { PK: o2.PK, SK: o2.SK } })
      .resolvesOnce({ Items: [o3, o4, o5] });
    ddbMock.on(BatchGetCommand).callsFake(batchGetFrom([p1, p2, p3, p4, p5]));

    const result = await handler(
      eventWith({ published: 'false', take: '2' }, 'Bearer good-token'),
      context,
    );

    const body = JSON.parse(result.body);
    expect(body.data.map((place: { id: string }) => place.id)).toEqual(['p3', 'p5']);
    // the page filled on the owner's very last item
    expect(body.meta).toMatchObject({ hasNextPage: false, nextCursor: null });

    const queries = ddbMock.commandCalls(QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[1].args[0].input.ExclusiveStartKey).toEqual({ PK: o2.PK, SK: o2.SK });
  });

  it('stops as soon as the page is full and resumes right after the last item consumed', async () => {
    verify.mockResolvedValue({ sub: 'sub-1' });
    findUserByExternalId.mockResolvedValue(ownerCaller);
    const [p1, o1] = owned('p1', true);
    const [p2, o2] = owned('p2', false);
    const [p3, o3] = owned('p3', true);
    ddbMock.on(QueryCommand, ownershipQuery).resolves({ Items: [o1, o2, o3] });
    ddbMock.on(BatchGetCommand).callsFake(batchGetFrom([p1, p2, p3]));

    const result = await handler(
      eventWith({ published: 'all', take: '2' }, 'Bearer good-token'),
      context,
    );

    const body = JSON.parse(result.body);
    expect(body.data.map((place: { id: string }) => place.id)).toEqual(['p1', 'p2']);
    expect(body.meta.hasNextPage).toBe(true);
    expect(decodeCursorKey(body.meta.nextCursor)).toEqual({ PK: o2.PK, SK: o2.SK });
  });
});
