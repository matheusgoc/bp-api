import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/offers/list';
import { OfferStatus } from '../../../src/models/offer';
import { UserRole } from '../../../src/models/user';
import { event, makeLocation, makeOffer, makePlace, PAST, partitionQuery } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'offers-list', awsRequestId: 'test' } as Context;
const params = { id: 'p1' };
const offersQuery = { IndexName: 'GSI2' };

const encodeCursor = (filter: string, key: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ filter, key })).toString('base64url');

const lastEvaluatedKey = {
  PK: 'OFFER#o1',
  SK: 'METADATA',
  GSI2PK: 'OFFER#PLACE#p1',
  GSI2SK: '2024-01-01T00:00:00.000Z',
};

const offersQueryInput = () => ddbMock.commandCalls(QueryCommand, offersQuery)[0].args[0].input;

describe('GET /places/{id}/offers', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [makePlace(), makeLocation()] });
    ddbMock.on(QueryCommand, offersQuery).resolves({ Items: [] });
  });

  it('lists every offer of the place, newest first, with derived statuses and summaries', async () => {
    ddbMock.on(QueryCommand, offersQuery).resolves({
      Items: [
        makeOffer({ id: 'a', locationId: 'l1' }),
        makeOffer({ id: 'b', status: OfferStatus.CANCELED }),
        makeOffer({ id: 'c', end: PAST }),
      ],
    });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.map((offer: { status: string }) => offer.status)).toEqual([
      OfferStatus.ACTIVE,
      OfferStatus.CANCELED,
      OfferStatus.EXPIRED,
    ]);
    expect(body.data[0].location).toEqual({
      id: 'l1',
      name: 'Centro',
      city: 'Belo Horizonte',
      state: 'MG',
    });
    expect(body.data[1].location).toBeUndefined();
    expect(body.data[1].place).toEqual({
      id: 'p1',
      name: 'Pizzaria do Bairro',
      logo: 'https://example.com/logo.png',
    });
    expect(body.meta).toEqual({
      take: 20,
      hasPreviousPage: false,
      hasNextPage: false,
      nextCursor: null,
    });

    const input = offersQueryInput();
    expect(input.KeyConditionExpression).toBe('GSI2PK = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'OFFER#PLACE#p1' });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(20);
    expect(input.ExclusiveStartKey).toBeUndefined();
  });

  it('passes take as Limit and returns a cursor that resumes the next page', async () => {
    ddbMock
      .on(QueryCommand, offersQuery)
      .resolves({ Items: [makeOffer()], LastEvaluatedKey: lastEvaluatedKey });

    const first = await handler(event(params, undefined, { take: '1' }), context);

    const { meta } = JSON.parse(first.body);
    expect(meta.hasNextPage).toBe(true);
    expect(offersQueryInput().Limit).toBe(1);

    ddbMock.resetHistory();
    ddbMock.on(QueryCommand, offersQuery).resolves({ Items: [makeOffer()] });

    const second = await handler(event(params, undefined, { cursor: meta.nextCursor }), context);

    expect(JSON.parse(second.body).meta).toMatchObject({
      hasPreviousPage: true,
      hasNextPage: false,
      nextCursor: null,
    });
    expect(offersQueryInput().ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });

  it.each(['0', '101', 'abc'])('rejects an invalid "take" value %s', async (take) => {
    const result = await handler(event(params, undefined, { take }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('rejects a malformed cursor', async () => {
    const result = await handler(event(params, undefined, { cursor: 'not-a-cursor' }), context);

    expect(result.statusCode).toBe(400);
  });

  it('rejects a cursor issued for another place', async () => {
    const cursor = encodeCursor('p2', lastEvaluatedKey);

    const result = await handler(event(params, undefined, { cursor }), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('"cursor" is invalid');
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [] });

    const result = await handler(event({ id: 'missing' }), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Place not found');
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
