import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));

import { handler } from '../../../src/handlers/locations/preview';
import { UserRole } from '../../../src/models/user';
import { event, makeLocation } from './fixtures';

const ddbMock = mockClient(ddb);
const context = { functionName: 'locations-preview', awsRequestId: 'test' } as Context;
const params = { id: 'p1', locationId: 'l1' };

describe('GET /places/{id}/locations/{locationId}', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER } });
  });

  it('returns the location', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeLocation({ lat: -19.9, lon: -43.9 }) });

    const result = await handler(event(params), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toMatchObject({ id: 'l1', name: 'Centro', lat: -19.9, lon: -43.9, workingHours: [] });
    expect(body.phone).toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({ PK: 'PLACE#p1', SK: 'LOCATION#l1' });
  });

  it('returns 404 when missing', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event(params), context);
    expect(result.statusCode).toBe(404);
  });

  it('returns 404 when soft-deleted', async () => {
    ddbMock.on(GetCommand).resolves({ Item: makeLocation({ deleted: true }) });

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
