import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb } from '../../../src/lib/dynamo';
import { s3 } from '../../../src/lib/s3';
import { forbidden } from '../../../src/lib/http';
import { UserRole } from '../../../src/models/user';

const requirePlaceAccess = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requirePlaceAccess: (...args: unknown[]) => requirePlaceAccess(...args),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/put-url'),
}));

import { handler } from '../../../src/handlers/places/uploadImage';

const ddbMock = mockClient(ddb);
const s3Mock = mockClient(s3);
const context = { functionName: 'places-upload-image', awsRequestId: 'test' } as Context;
const event = (id: string, type: string, body?: unknown) =>
  ({
    pathParameters: { id, type },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as APIGatewayProxyEvent;

describe('PATCH /places/{id}/images/{type}', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    requirePlaceAccess.mockReset();
    requirePlaceAccess.mockResolvedValue({ user: { id: 'u1', role: UserRole.OWNER }, place: {} });
  });

  it('issues a presigned upload URL and writes the draft URL to the draft field', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(event('1', 'photo', { contentType: 'image/jpeg' }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.uploadUrl).toBe('https://signed.example/put-url');
    expect(body.draftUrl).toMatch(/\/places\/1\/photo-draft-\d+\.jpg$/);
    expect(body.expiresIn).toBe(300);

    const call = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(call.Key).toEqual({ PK: 'PLACE#1', SK: 'METADATA' });
    expect(call.UpdateExpression).toContain('SET draftPhoto = :url');
    expect(call.ExpressionAttributeValues?.[':url']).toBe(body.draftUrl);

    // the presigned PUT targets the same versioned key the draft URL points at
    const presigned = (getSignedUrl as jest.Mock).mock.calls[0][1].input;
    expect(body.draftUrl.endsWith(`/${presigned.Key}`)).toBe(true);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('gives every upload a new draft URL, deleting the draft it replaces', async () => {
    const previous = 'http://localhost:9000/bp-api-local/places/1/photo-draft-1700000000000.jpg';
    requirePlaceAccess.mockResolvedValue({
      user: { id: 'u1', role: UserRole.OWNER },
      place: { draftPhoto: previous, draftLogo: 'http://localhost:9000/bp-api-local/places/1/logo-draft-1.png' },
    });
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await handler(event('1', 'photo', { contentType: 'image/jpeg' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).draftUrl).not.toBe(previous);
    const deletes = s3Mock.commandCalls(DeleteObjectCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0].input.Key).toBe('places/1/photo-draft-1700000000000.jpg');
  });

  it('still issues the upload URL when deleting the replaced draft fails', async () => {
    requirePlaceAccess.mockResolvedValue({
      user: { id: 'u1', role: UserRole.OWNER },
      place: { draftPhoto: 'http://localhost:9000/bp-api-local/places/1/photo-draft-1.jpg' },
    });
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).rejects(new Error('AccessDenied'));

    const result = await handler(event('1', 'photo', { contentType: 'image/jpeg' }), context);

    expect(result.statusCode).toBe(200);
  });

  it('works for the logo type too', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(event('1', 'logo', { contentType: 'image/png' }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.draftUrl).toMatch(/\/places\/1\/logo-draft-\d+\.png$/);
  });

  it('returns 400 for an invalid type', async () => {
    const result = await handler(event('1', 'banner', { contentType: 'image/jpeg' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for an invalid JSON body', async () => {
    const result = await handler(
      { pathParameters: { id: '1', type: 'photo' }, body: '{not json' } as unknown as APIGatewayProxyEvent,
      context,
    );
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for an unsupported content type', async () => {
    const result = await handler(event('1', 'photo', { contentType: 'application/pdf' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('missing', 'photo', { contentType: 'image/jpeg' }), context);
    expect(result.statusCode).toBe(404);
  });

  it('passes through the place access check response', async () => {
    requirePlaceAccess.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('1', 'photo', { contentType: 'image/jpeg' }), context);

    expect(result.statusCode).toBe(403);
    expect(requirePlaceAccess).toHaveBeenCalledWith(expect.anything(), '1');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
