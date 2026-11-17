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

import { handler } from '../../../src/handlers/offers/enable';
import { OfferStatus } from '../../../src/models/offer';
import { UserRole } from '../../../src/models/user';
import { event, makeOffer, makePlace, partitionQuery } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'offers-enable', awsRequestId: 'test' } as Context;
const params = { id: 'p1', offerId: 'o1' };

describe('PATCH /places/{id}/offers/{offerId}', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [makePlace()] });
  });

  it('sets the status to active and puts the offer back in GSI1', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: makeOffer({ status: OfferStatus.ACTIVE }) });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      id: 'o1',
      status: OfferStatus.ACTIVE,
      place: { id: 'p1' },
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: 'OFFER#o1', SK: 'METADATA' });
    expect(input.UpdateExpression).toBe(
      'SET #status = :active, updatedAt = :updatedAt, GSI1PK = :gsi1pk',
    );
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND placeId = :placeId');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':active': OfferStatus.ACTIVE,
      ':gsi1pk': 'OFFER#ACTIVE#PLACE#p1',
      ':placeId': 'p1',
    });
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('returns 404 when the offer is missing or belongs to another place', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Offer not found');
  });

  it('returns 403 when the caller does not own the place', async () => {
    requireRole.mockResolvedValue({ user: { id: 'u2', role: UserRole.OWNER } });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error).toBe('Not an owner of this place');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
