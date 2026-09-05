import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/put-url'),
}));

import { handler } from '../../../src/handlers/places/uploadImage';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-upload-image', awsRequestId: 'test' } as Context;
const event = (id: string, type: string, body?: unknown) =>
  ({
    pathParameters: { id, type },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as APIGatewayProxyEvent;

describe('PATCH /places/{id}/images/{type}', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('issues a presigned upload URL and writes the draft URL to the draft field', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(event('1', 'photo', { contentType: 'image/jpeg' }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.uploadUrl).toBe('https://signed.example/put-url');
    expect(body.draftUrl).toContain('places/1/photo-draft.jpg');
    expect(body.expiresIn).toBe(300);

    const call = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(call.Key).toEqual({ PK: 'PLACE#1', SK: 'METADATA' });
    expect(call.UpdateExpression).toContain('SET draftPhoto = :url');
  });

  it('works for the logo type too', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(event('1', 'logo', { contentType: 'image/png' }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.draftUrl).toContain('places/1/logo-draft.png');
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
});
