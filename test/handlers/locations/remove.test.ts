import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/locations/remove';
import { PlaceStatus } from '../../../src/models/place';
import { UserRole } from '../../../src/models/user';
import { cancelled, event } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'locations-remove', awsRequestId: 'test' } as Context;
const params = { id: 'p1', locationId: 'l1' };

describe('DELETE /places/{id}/locations/{locationId}', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
  });

  it('soft-deletes the location and resets the place to reviewing', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: 'l1' });

    const [location, place] = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(location.Delete).toBeUndefined();
    expect(location.Update?.Key).toEqual({ PK: 'PLACE#p1', SK: 'LOCATION#l1' });
    expect(location.Update?.ExpressionAttributeValues?.[':true']).toBe(true);
    expect(place.Update?.ExpressionAttributeValues?.[':status']).toBe(PlaceStatus.REVIEWING);
  });

  it('passes through the role check response', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event(params), context);
    expect(result.statusCode).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns 404 when the location is missing or already deleted', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None'));

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Location not found');
  });

  it('returns 404 when the place is missing', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('None', 'ConditionalCheckFailed'));

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Place not found');
  });
});
