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

import { handler } from '../../../src/handlers/offers/cancel';
import { OfferStatus } from '../../../src/models/offer';
import { UserRole } from '../../../src/models/user';
import { event, makeOffer, makePlace, partitionQuery } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'offers-cancel', awsRequestId: 'test' } as Context;
const params = { id: 'p1', offerId: 'o1' };

describe('DELETE /places/{id}/offers/{offerId}', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [makePlace()] });
  });

  it('sets the status to canceled and drops the offer from GSI1', async () => {
    const { GSI1PK, ...canceled } = makeOffer({ status: OfferStatus.CANCELED });
    ddbMock.on(UpdateCommand).resolves({ Attributes: canceled });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      id: 'o1',
      status: OfferStatus.CANCELED,
      place: { id: 'p1' },
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: 'OFFER#o1', SK: 'METADATA' });
    expect(input.UpdateExpression).toBe(
      'SET #status = :canceled, updatedAt = :updatedAt REMOVE GSI1PK',
    );
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND placeId = :placeId');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':canceled': OfferStatus.CANCELED,
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
});
