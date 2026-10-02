import type { APIGatewayProxyEvent } from 'aws-lambda';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { LocationItem } from '../../../src/models/location';

export const validBody = {
  name: 'Centro',
  city: 'Belo Horizonte',
  state: 'MG',
  address: 'Rua A, 100',
  postalCode: '30000-000',
  lat: -19.9167,
  lon: -43.9345,
  phone: '31999999999',
  isWhatsapp: true,
  email: 'centro@example.com',
  workingHours: [{ weekDay: 'monday', start: '08:00', end: '18:00' }],
};

export const event = (
  pathParameters: Record<string, string>,
  body?: unknown,
): APIGatewayProxyEvent =>
  ({
    pathParameters,
    body: body === undefined ? null : JSON.stringify(body),
    headers: {},
    requestContext: {},
  }) as unknown as APIGatewayProxyEvent;

// Cancellation reasons are positional: [location item, place item]
export const cancelled = (locationCode: string, placeCode: string) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: locationCode }, { Code: placeCode }],
  });

export const makeLocation = (overrides: Partial<LocationItem> = {}): LocationItem => ({
  PK: 'PLACE#p1',
  SK: 'LOCATION#l1',
  id: 'l1',
  placeId: 'p1',
  name: 'Centro',
  city: 'Belo Horizonte',
  state: 'MG',
  address: 'Rua A, 100',
  postalCode: '30000-000',
  lat: null,
  lon: null,
  phone: '',
  isWhatsapp: false,
  email: '',
  workingHours: [],
  deleted: false,
  deletedAt: '',
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});
