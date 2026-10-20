import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/offers/preview';
import { OfferStatus } from '../../../src/models/offer';
import { UserRole } from '../../../src/models/user';
import { event, makeLocation, makeOffer, makePlace, PAST, partitionQuery } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'offers-preview', awsRequestId: 'test' } as Context;
const params = { id: 'p1', offerId: 'o1' };

describe('GET /places/{id}/offers/{offerId}', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
    ddbMock.on(QueryCommand, partitionQuery).resolves({ Items: [makePlace(), makeLocation()] });
  });

  it('returns the offer with its place and location summaries', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeOffer({ locationId: 'l1' }) });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      id: 'o1',
      title: '10% off on pizzas',
      discount: 10,
      status: OfferStatus.ACTIVE,
      place: { id: 'p1', name: 'Pizzaria do Bairro', logo: 'https://example.com/logo.png' },
      location: { id: 'l1', name: 'Centro', city: 'Belo Horizonte', state: 'MG' },
    });
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'OFFER#o1',
      SK: 'METADATA',
    });
  });

  it('shows an active offer whose end has passed as expired', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeOffer({ end: PAST }) });

    const result = await handler(event(params), context);

    expect(JSON.parse(result.body).status).toBe(OfferStatus.EXPIRED);
  });

  it('keeps a canceled offer canceled after its end', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeOffer({ status: OfferStatus.CANCELED, end: PAST }) });

    const result = await handler(event(params), context);

    expect(JSON.parse(result.body).status).toBe(OfferStatus.CANCELED);
  });

  it('returns 404 when missing', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Offer not found');
  });

  it('returns 404 when the offer belongs to another place', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeOffer({ placeId: 'p2' }) });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(404);
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
