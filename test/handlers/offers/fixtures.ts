import type { APIGatewayProxyEvent } from 'aws-lambda';
import { NO_END_SORT_KEY, OfferItem, OfferStatus } from '../../../src/models/offer';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

export { makeLocation } from '../locations/fixtures';

// fixed far-away dates, so derived statuses don't depend on when the tests run
export const PAST = '2000-01-01T00:00:00.000Z';
export const FUTURE = '2999-01-01T00:00:00.000Z';

export const validBody = {
  title: '10% off on pizzas',
  discount: 10,
  start: '2026-01-01T00:00:00-03:00',
  end: '2999-01-01T00:00:00-03:00',
};

// validBody's dates as stored (normalized to UTC)
export const storedStart = '2026-01-01T03:00:00.000Z';
export const storedEnd = '2999-01-01T03:00:00.000Z';

// QueryCommand inputs, for mocking the place partition and the live offers separately
export const partitionQuery = { KeyConditionExpression: 'PK = :pk' };
export const liveOffersQuery = { IndexName: 'GSI1' };

export const event = (
  pathParameters: Record<string, string>,
  body?: unknown,
  queryStringParameters?: Record<string, string>,
): APIGatewayProxyEvent =>
  ({
    pathParameters,
    queryStringParameters: queryStringParameters ?? null,
    body: body === undefined ? null : JSON.stringify(body),
    headers: {},
    requestContext: {},
  }) as unknown as APIGatewayProxyEvent;

export const makePlace = (overrides: Partial<PlaceItem> = {}): PlaceItem => ({
  PK: 'PLACE#p1',
  SK: 'METADATA',
  GSI1SK: '2024-01-01T00:00:00.000Z',
  GSI2PK: 'PLACE',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: 'p1',
  name: 'Pizzaria do Bairro',
  description: '',
  category: 'cat-1',
  photo: '',
  logo: 'https://example.com/logo.png',
  draftPhoto: '',
  draftLogo: '',
  website: '',
  status: PlaceStatus.ACTIVE,
  reason: '',
  published: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

export const makeOffer = (overrides: Partial<OfferItem> = {}): OfferItem => ({
  PK: 'OFFER#o1',
  SK: 'METADATA',
  GSI1PK: 'OFFER#ACTIVE#PLACE#p1',
  GSI1SK: NO_END_SORT_KEY,
  GSI2PK: 'OFFER#PLACE#p1',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: 'o1',
  placeId: 'p1',
  locationId: '',
  title: '10% off on pizzas',
  discount: 10,
  start: '',
  end: '',
  status: OfferStatus.ACTIVE,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});
