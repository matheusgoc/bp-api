import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/offers/add';
import { NO_END_SORT_KEY, OfferStatus } from '../../../src/models/offer';
import { UserRole } from '../../../src/models/user';
import {
  event,
  makeLocation,
  makePlace,
  partitionQuery,
  storedEnd,
  storedStart,
  validBody,
} from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'offers-add', awsRequestId: 'test' } as Context;

describe('POST /places/{id}/offers', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [makePlace(), makeLocation()] });
    ddbMock.on(PutCommand).resolves({});
  });

  it('creates an active place offer, in both GSIs, with the place summary', async () => {
    const result = await handler(event({ id: 'p1' }, validBody), context);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body).toMatchObject({
      title: validBody.title,
      discount: validBody.discount,
      start: storedStart,
      end: storedEnd,
      status: OfferStatus.ACTIVE,
      place: { id: 'p1', name: 'Pizzaria do Bairro', logo: 'https://example.com/logo.png' },
    });
    expect(body.id).toBeDefined();
    expect(body.location).toBeUndefined();

    expect(requireRole).toHaveBeenCalledWith(expect.anything(), [UserRole.OWNER, UserRole.ADMIN]);
    expect(
      ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues,
    ).toEqual({ ':pk': 'PLACE#p1' });

    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(put.Item).toMatchObject({
      PK: `OFFER#${body.id}`,
      SK: 'METADATA',
      GSI1PK: 'OFFER#ACTIVE#PLACE#p1',
      GSI1SK: storedEnd,
      GSI2PK: 'OFFER#PLACE#p1',
      placeId: 'p1',
      locationId: '',
      start: storedStart,
      end: storedEnd,
      status: OfferStatus.ACTIVE,
      createdBy: 'u1',
    });
    expect(put.Item?.GSI2SK).toBe(put.Item?.createdAt);
  });

  it('creates a location offer when ?location is given', async () => {
    const result = await handler(event({ id: 'p1' }, validBody, { location: 'l1' }), context);

    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body).location).toEqual({
      id: 'l1',
      name: 'Centro',
      city: 'Belo Horizonte',
      state: 'MG',
    });
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item?.locationId).toBe('l1');
  });

  it('stores absent optional fields as empty and keeps a canceled offer out of GSI1', async () => {
    const result = await handler(
      event({ id: 'p1' }, { title: 'Free dessert', status: OfferStatus.CANCELED }),
      context,
    );

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.status).toBe(OfferStatus.CANCELED);
    expect(body.discount).toBeUndefined();
    expect(body.start).toBeUndefined();
    expect(body.end).toBeUndefined();

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item).toMatchObject({ discount: null, start: '', end: '', GSI1SK: NO_END_SORT_KEY });
    expect(item?.GSI1PK).toBeUndefined();
  });

  it.each([
    [{ ...validBody, title: ' ' }, '"title" is required'],
    [{ ...validBody, discount: 0 }, '"discount" must be a positive number'],
    [{ ...validBody, discount: '10' }, '"discount" must be a positive number'],
    [{ ...validBody, start: '2026-10-01' }, '"start" must be an ISO 8601 date-time'],
    [{ ...validBody, end: '2026-10-31T23:59:59' }, '"end" must be an ISO 8601 date-time'],
    [{ ...validBody, start: validBody.end, end: validBody.start }, '"end" must be after "start"'],
    [{ ...validBody, status: 'expired' }, '"status" must be one of "active", "canceled"'],
  ])('returns 400 for invalid body %#', async (body, message) => {
    const result = await handler(event({ id: 'p1' }, body), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain(message);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('returns 400 for an empty ?location', async () => {
    const result = await handler(event({ id: 'p1' }, validBody, { location: ' ' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [] });

    const result = await handler(event({ id: 'missing' }, validBody), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Place not found');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it.each([
    ['missing', 'nope'],
    ['soft-deleted', 'l2'],
  ])('returns 400 when the location is %s', async (_, location) => {
    ddbMock.on(QueryCommand, partitionQuery).resolves({
      Items: [makePlace(), makeLocation({ SK: 'LOCATION#l2', id: 'l2', deleted: true })],
    });

    const result = await handler(event({ id: 'p1' }, validBody, { location }), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('"location" does not exist');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event({ id: 'p1' }, validBody), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('returns 403 when the caller does not own the place', async () => {
    requireRole.mockResolvedValue({ user: { id: 'u2', role: UserRole.OWNER } });

    const result = await handler(event({ id: 'p1' }, validBody), context);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error).toBe('Not an owner of this place');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
