import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand } from '@aws-sdk/client-s3';
import { requireRole } from '../../lib/access';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { BUCKET_NAME, PUBLIC_URL_BASE, s3 } from '../../lib/s3';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceItem, toPlaceModel } from '../../models/place';
import { UserRole } from '../../models/user';
import { deletePlaceImage, placeImageKey, placeImageKeyFromUrl } from './images';

/**
 * Approve Place Image
 *
 * PATCH /places/{id}/images/{type}/approve (Cognito-protected, admin only)
 * 
 * {type} is 'photo' or 'logo'. 
 * 
 * Moves draft(Logo|Photo) to the live photo/logo field. 
 *
 * The S3 object is copied from its draft key to a new live key server-side
 * versioned, so every approved image gets a new public URL
 * then the draft and the previously approved image are deleted
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('"id" path parameter is required');

  const type = event.pathParameters?.type;
  if (type !== 'photo' && type !== 'logo') {
    return badRequest('"type" path parameter must be "photo" or "logo"');
  }

  const draftField = type === 'photo' ? 'draftPhoto' : 'draftLogo';
  const key = { PK: `PLACE#${id}`, SK: 'METADATA' };

  try {
    const access = await requireRole(event, [UserRole.ADMIN]);
    if ('response' in access) return access.response;

    const existing = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
    if (!existing.Item) return notFound('Place not found');

    const place = existing.Item as PlaceItem;
    const draftUrl = place[draftField];
    const draftKey = draftUrl && placeImageKeyFromUrl(id, draftUrl);
    if (!draftKey) return badRequest(`No pending draft "${type}" to approve`);

    const ext = draftKey.slice(draftKey.lastIndexOf('.') + 1);
    const liveKey = placeImageKey(id, type, ext, false);
    const liveUrl = `${PUBLIC_URL_BASE}/${liveKey}`;

    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: BUCKET_NAME,
          CopySource: `${BUCKET_NAME}/${draftKey}`,
          Key: liveKey,
        }),
      );
    } catch (error) {
      logger.error('Failed to copy draft image to its live key', error as Error);
      return badRequest('Draft image was not found in storage — re-upload before approving');
    }

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: `SET ${type} = :url, ${draftField} = :empty, updatedAt = :updatedAt`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':url': liveUrl,
          ':empty': '',
          ':updatedAt': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    // the draft and the image it replaces are no longer referenced
    await deletePlaceImage(draftKey);
    const previousLiveKey = place[type] && placeImageKeyFromUrl(id, place[type]);
    if (previousLiveKey) await deletePlaceImage(previousLiveKey);

    logger.info('Approved place image', { id, type });
    return json(200, toPlaceModel(result.Attributes as PlaceItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Place not found');
    }
    logger.error('Failed to approve place image', error as Error);
    return serverError();
  }
};
