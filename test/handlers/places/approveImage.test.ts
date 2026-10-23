import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ddb } from '../../../src/lib/dynamo';
import { forbidden } from '../../../src/lib/http';
import { UserRole } from '../../../src/models/user';

const requireRole = jest.fn();
jest.mock('../../../src/lib/access', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
}));
import { s3 } from '../../../src/lib/s3';
import { handler } from '../../../src/handlers/places/approveImage';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

const ddbMock = mockClient(ddb);
const s3Mock = mockClient(s3);
const context = { functionName: 'places-approve-image', awsRequestId: 'test' } as Context;
const event = (id: string, type: string) =>
  ({ pathParameters: { id, type } }) as unknown as APIGatewayProxyEvent;

const baseItem: PlaceItem = {
  PK: 'PLACE#1',
  SK: 'METADATA',
  GSI1SK: '2024-01-01T00:00:00.000Z',
  GSI2PK: 'PLACE',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: '1',
  name: 'X',
  description: '',
  category: 'cat-1',
  photo: '',
  logo: '',
  draftPhoto: 'http://localhost:9000/bp-api-local/places/1/photo-draft.jpg',
  draftLogo: '',
  website: '',
  status: PlaceStatus.DRAFT,
  reason: '',
  published: false,
  ownerBy: ['u1'],
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('PATCH /places/{id}/images/{type}/approve', () => {
  beforeEach(() => {
    ddbMock.reset();
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: 'admin-1', role: UserRole.ADMIN } });
    s3Mock.reset();
  });

  it('copies the draft object to its live key and moves the URL to the live field', async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseItem });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        ...baseItem,
        photo: 'http://localhost:9000/bp-api-local/places/1/photo.jpg',
        draftPhoto: '',
      },
    });

    const result = await handler(event('1', 'photo'), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.photo).toBe('http://localhost:9000/bp-api-local/places/1/photo.jpg');

    const copyCall = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(copyCall.CopySource).toContain('places/1/photo-draft.jpg');
    expect(copyCall.Key).toMatch(/^places\/1\/photo-\d+\.jpg$/);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(updateCall.UpdateExpression).toContain('SET photo = :url, draftPhoto = :empty');
    expect(updateCall.ExpressionAttributeValues?.[':url']).toMatch(new RegExp(`/${copyCall.Key}$`));

    // no previously approved photo, so only the draft is cleaned up
    const deletes = s3Mock.commandCalls(DeleteObjectCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0].input.Key).toBe('places/1/photo-draft.jpg');
  });

  it('gives the approved image a new URL, deleting the image it replaces', async () => {
    const draftPhoto = 'http://localhost:9000/bp-api-local/places/1/photo-draft-1700000000001.png';
    const photo = 'http://localhost:9000/bp-api-local/places/1/photo-1700000000000.jpg';
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, draftPhoto, photo } });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: baseItem });

    const result = await handler(event('1', 'photo'), context);

    expect(result.statusCode).toBe(200);
    const copyCall = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(copyCall.CopySource).toBe('/places/1/photo-draft-1700000000001.png');
    expect(copyCall.Key).toMatch(/^places\/1\/photo-\d+\.png$/);
    expect(copyCall.Key).not.toBe('places/1/photo-1700000000000.jpg');
    expect(s3Mock.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input.Key)).toEqual([
      'places/1/photo-draft-1700000000001.png',
      'places/1/photo-1700000000000.jpg',
    ]);
  });

  it('still approves when deleting the replaced objects fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseItem });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).rejects(new Error('AccessDenied'));
    ddbMock.on(UpdateCommand).resolves({ Attributes: baseItem });

    const result = await handler(event('1', 'photo'), context);

    expect(result.statusCode).toBe(200);
  });

  it('works for the logo type too', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...baseItem, draftLogo: 'http://localhost:9000/bp-api-local/places/1/logo-draft.png' },
    });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...baseItem, logo: 'x' } });

    const result = await handler(event('1', 'logo'), context);
    expect(result.statusCode).toBe(200);

    const copyCall = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(copyCall.Key).toMatch(/^places\/1\/logo-\d+\.png$/);
  });

  it('returns 400 for an invalid type', async () => {
    const result = await handler(event('1', 'banner'), context);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event('missing', 'photo'), context);
    expect(result.statusCode).toBe(404);
  });

  it('returns 400 when there is no pending draft (empty string)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, draftPhoto: '' } });

    const result = await handler(event('1', 'photo'), context);
    expect(result.statusCode).toBe(400);
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
  });

  it('returns 400 when there is no pending draft (attribute absent, pre-migration item)', async () => {
    const { draftPhoto: _draftPhoto, ...legacyItem } = baseItem;
    ddbMock.on(GetCommand).resolves({ Item: legacyItem });

    const result = await handler(event('1', 'photo'), context);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 without approving when the draft object copy fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseItem });
    s3Mock.on(CopyObjectCommand).rejects(new Error('NoSuchKey'));

    const result = await handler(event('1', 'photo'), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('returns 404 if the place is deleted between the read and the update', async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseItem });
    s3Mock.on(CopyObjectCommand).resolves({});
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('1', 'photo'), context);
    expect(result.statusCode).toBe(404);
  });

  it('requires the admin role', async () => {
    requireRole.mockResolvedValue({ response: forbidden() });

    const result = await handler(event('1', 'photo'), context);

    expect(result.statusCode).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(expect.anything(), [UserRole.ADMIN]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
