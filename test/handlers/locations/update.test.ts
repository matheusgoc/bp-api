import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/locations/update';
import { PlaceStatus } from '../../../src/models/place';
import { UserRole } from '../../../src/models/user';
import { cancelled, event, validBody } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'locations-update', awsRequestId: 'test' } as Context;
const params = { id: 'p1', locationId: 'l1' };

describe('PUT /places/{id}/locations/{locationId}', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.ADMIN } });
  });

  it('replaces the location fields and resets the place to reviewing', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event(params, validBody), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: 'l1', ...validBody });

    const [location, place] = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(location.Update?.Key).toEqual({ PK: 'PLACE#p1', SK: 'LOCATION#l1' });
    expect(location.Update?.ConditionExpression).toBe('attribute_exists(PK) AND #deleted = :false');
    expect(location.Update?.ExpressionAttributeValues).toMatchObject({
      ':name': 'Centro',
      ':lat': validBody.lat,
      ':workingHours': validBody.workingHours,
    });
    expect(place.Update?.ExpressionAttributeValues?.[':status']).toBe(PlaceStatus.REVIEWING);
  });

  it('clears omitted optional fields', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const { lat, phone, ...rest } = validBody;

    await handler(event(params, rest), context);

    const location = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0];
    expect(location.Update?.ExpressionAttributeValues).toMatchObject({ ':lat': null, ':phone': '' });
  });

  it('returns 400 for an invalid body', async () => {
    const result = await handler(event(params, { ...validBody, city: '' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event(params, validBody), context);
    expect(result.statusCode).toBe(403);
  });

  it('returns 404 when the location is missing or soft-deleted', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None'));

    const result = await handler(event(params, validBody), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Location not found');
  });

  it('returns 404 when the place is missing', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'ConditionalCheckFailed'));

    const result = await handler(event(params, validBody), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Place not found');
  });
});
