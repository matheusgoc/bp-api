import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requirePlaceAccess = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requirePlaceAccess: (...args: unknown[]) => requirePlaceAccess(...args),
}));

import { handler } from '../../../src/handlers/locations/add';
import { PlaceStatus } from '../../../src/models/place';
import { UserRole } from '../../../src/models/user';
import { cancelled, event, validBody } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'locations-add', awsRequestId: 'test' } as Context;

describe('POST /places/{id}/locations', () => {
  beforeEach(() => {
    ddbMock.reset();
    requirePlaceAccess.mockReset();
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
  });

  it('creates a location and resets the place to reviewing in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event({ id: 'p1' }, validBody), context);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body).toMatchObject({ ...validBody });
    expect(body.id).toBeDefined();
    expect(body.deleted).toBeUndefined();

    expect(requirePlaceAccess).toHaveBeenCalledWith(expect.anything(), 'p1');

    const [put, place] = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(put.Put?.Item).toMatchObject({
      PK: 'PLACE#p1',
      SK: `LOCATION#${body.id}`,
      placeId: 'p1',
      lat: validBody.lat,
      lon: validBody.lon,
      deleted: false,
      createdBy: 'u1',
    });
    expect(place.Update?.Key).toEqual({ PK: 'PLACE#p1', SK: 'METADATA' });
    expect(place.Update?.ExpressionAttributeValues?.[':status']).toBe(PlaceStatus.REVIEWING);
  });

  it('stores absent optional fields as empty and omits them from the response', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const { lat, lon, phone, email, isWhatsapp, ...required } = validBody;

    const result = await handler(event({ id: 'p1' }, required), context);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.lat).toBeUndefined();
    expect(body.phone).toBeUndefined();
    const item = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Put?.Item;
    expect(item).toMatchObject({ lat: null, lon: null, phone: '', email: '', isWhatsapp: false });
  });

  it.each([
    [{ ...validBody, name: ' ' }, '"name" is required'],
    [{ ...validBody, postalCode: undefined }, '"postalCode" is required'],
    [{ ...validBody, workingHours: undefined }, '"workingHours" must be an array'],
    [{ ...validBody, workingHours: [{ weekDay: 'monday', start: '8:00', end: '18:00' }] }, '"workingHours[0].start" must be a time in HH:mm format'],
    [{ ...validBody, workingHours: [{ start: '08:00', end: '18:00' }] }, '"workingHours[0].weekDay" is required'],
    [{ ...validBody, lat: '-19.9' }, '"lat" must be a number between -90 and 90'],
    [{ ...validBody, lon: 200 }, '"lon" must be a number between -180 and 180'],
    [{ ...validBody, isWhatsapp: 'yes' }, '"isWhatsapp" must be a boolean'],
  ])('returns 400 for invalid body %#', async (body, message) => {
    const result = await handler(event({ id: 'p1' }, body), context);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(message);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('passes through the place access check response', async () => {
    requirePlaceAccess.mockResolvedValue({ response: forbidden() });

    const result = await handler(event({ id: 'p1' }, validBody), context);

    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('None', 'ConditionalCheckFailed'));

    const result = await handler(event({ id: 'missing' }, validBody), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Place not found');
  });
});
