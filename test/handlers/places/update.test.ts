import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../../src/lib/dynamo';
import { handler } from '../../../src/handlers/places/update';
import { PlaceItem, PlaceStatus } from '../../../src/models/place';

const ddbMock = mockClient(ddb);
const context = { functionName: 'places-update', awsRequestId: 'test' } as Context;

const baseItem: PlaceItem = {
  PK: 'PLACE#1',
  SK: 'METADATA',
  GSI1SK: '2024-01-01T00:00:00.000Z',
  GSI2PK: 'PLACE',
  GSI2SK: '2024-01-01T00:00:00.000Z',
  id: '1',
  name: 'Old name',
  description: '',
  category: 'cat-1',
  photo: 'p',
  logo: '',
  draftPhoto: '',
  draftLogo: '',
  website: '',
  status: PlaceStatus.ACTIVE,
  reason: '',
  published: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const event = (id: string, body: unknown) =>
  ({ pathParameters: { id }, body: JSON.stringify(body), requestContext: {} }) as unknown as APIGatewayProxyEvent;

describe('PUT /places/{id}', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('merges only editable fields and forces status back to reviewing, leaving published untouched', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...baseItem, name: 'New name', status: PlaceStatus.REVIEWING },
    });

    const result = await handler(event('1', { name: 'New name' }), context);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('New name');
    expect(body.status).toBe(PlaceStatus.REVIEWING);
    expect(body.published).toBe(true);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues?.[':status']).toBe(PlaceStatus.REVIEWING);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('ignores status/reason/published/photo/logo fields present in the body', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: baseItem });

    await handler(
      event('1', { status: 'active', published: true, reason: 'x', photo: 'new', logo: 'new' }),
      context,
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const names = Object.values(call.args[0].input.ExpressionAttributeNames ?? {});
    expect(names).not.toContain('photo');
    expect(names).not.toContain('logo');
    expect(names).not.toContain('published');
    expect(names).not.toContain('reason');
  });

  it('returns 404 when the place does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'fail', $metadata: {} }));

    const result = await handler(event('missing', { name: 'X' }), context);
    expect(result.statusCode).toBe(404);
  });

  it('rejects an empty string for an editable field', async () => {
    const result = await handler(event('1', { name: '  ' }), context);
    expect(result.statusCode).toBe(400);
  });

  it('writes category into the "category" attribute when it references an existing category', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'CATEGORY#cat-2', SK: 'METADATA' } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...baseItem, category: 'cat-2' } });

    const result = await handler(event('1', { category: 'cat-2' }), context);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).category).toEqual({ id: 'cat-2' });

    const getCall = ddbMock.commandCalls(GetCommand)[0];
    expect(getCall.args[0].input.Key).toEqual({ PK: 'CATEGORY#cat-2', SK: 'METADATA' });

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const names = Object.values(call.args[0].input.ExpressionAttributeNames ?? {});
    expect(names).toContain('category');
    expect(call.args[0].input.ExpressionAttributeValues?.[':category']).toBe('cat-2');
  });

  it('rejects a category that does not reference an existing category', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await handler(event('1', { category: 'missing' }), context);

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
