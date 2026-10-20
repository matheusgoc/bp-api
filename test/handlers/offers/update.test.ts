import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/offers/update';
import { NO_END_SORT_KEY, OfferStatus } from '../../../src/models/offer';
import { UserRole } from '../../../src/models/user';
import {
  event,
  makeLocation,
  makeOffer,
  makePlace,
  partitionQuery,
  storedEnd,
  storedStart,
  validBody,
} from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'offers-update', awsRequestId: 'test' } as Context;
const params = { id: 'p1', offerId: 'o1' };

const updateInput = () => ddbMock.commandCalls(UpdateCommand)[0].args[0].input;

describe('PUT /places/{id}/offers/{offerId}', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.ADMIN } });
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [makePlace(), makeLocation()] });
    ddbMock.on(UpdateCommand).resolves({ Attributes: makeOffer({ locationId: 'l1' }) });
  });

  it('replaces the offer fields and keeps the status (and GSI1PK) when omitted', async () => {
    const result = await handler(event(params, validBody), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      id: 'o1',
      status: OfferStatus.ACTIVE,
      place: { id: 'p1', name: 'Pizzaria do Bairro' },
      location: { id: 'l1', name: 'Centro' },
    });

    const input = updateInput();
    expect(input.Key).toEqual({ PK: 'OFFER#o1', SK: 'METADATA' });
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND placeId = :placeId');
    expect(input.ReturnValues).toBe('ALL_NEW');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':placeId': 'p1',
      ':title': validBody.title,
      ':discount': validBody.discount,
      ':start': storedStart,
      ':end': storedEnd,
      ':gsi1sk': storedEnd,
    });
    expect(input.UpdateExpression).not.toContain('#status');
    expect(input.UpdateExpression).not.toContain('GSI1PK');
  });

  it('clears omitted optional fields', async () => {
    await handler(event(params, { title: 'Free dessert' }), context);

    expect(updateInput().ExpressionAttributeValues).toMatchObject({
      ':discount': null,
      ':start': '',
      ':end': '',
      ':gsi1sk': NO_END_SORT_KEY,
    });
  });

  it('reactivates a canceled offer by restoring GSI1PK', async () => {
    await handler(event(params, { ...validBody, status: OfferStatus.ACTIVE }), context);

    const input = updateInput();
    expect(input.UpdateExpression).toContain('#status = :status');
    expect(input.UpdateExpression).toContain('GSI1PK = :gsi1pk');
    expect(input.UpdateExpression).not.toContain('REMOVE');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':status': OfferStatus.ACTIVE,
      ':gsi1pk': 'OFFER#ACTIVE#PLACE#p1',
    });
  });

  it('removes GSI1PK when set to canceled', async () => {
    await handler(event(params, { ...validBody, status: OfferStatus.CANCELED }), context);

    const input = updateInput();
    expect(input.UpdateExpression).toMatch(/ REMOVE GSI1PK$/);
    expect(input.ExpressionAttributeValues?.[':status']).toBe(OfferStatus.CANCELED);
  });

  it('returns 400 for an invalid body', async () => {
    const result = await handler(event(params, { ...validBody, status: 'expired' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event(params, validBody), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('returns 404 when the offer is missing or belongs to another place', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event(params, validBody), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Offer not found');
  });
});
