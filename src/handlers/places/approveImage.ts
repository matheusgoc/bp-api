import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { BUCKET_NAME, PUBLIC_URL_BASE, s3 } from '../../lib/s3';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { PlaceItem, toPlaceModel } from '../../models/place';

/**
 * Approve Place Image
 *
 * PATCH /places/{id}/images/{type}/approve (Cognito-protected)
 * 
 * {type} is 'photo' or 'logo'. 
 * 
 * Moves draft(Logo|Photo) to the live photo/logo field. 
 *
 * The S3 object is copied from its draft key to its live key server-side, 
 * so the live key's bytes never change until an explicit approval
 * 
 * @todo verification and moderation step
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
    const existing = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
    if (!existing.Item) return notFound('Place not found');

    const draftUrl = (existing.Item as PlaceItem)[draftField];
    if (!draftUrl) return badRequest(`No pending draft "${type}" to approve`);

    const ext = draftUrl.slice(draftUrl.lastIndexOf('.') + 1);
    const draftKey = `places/${id}/${type}-draft.${ext}`;
    const liveKey = `places/${id}/${type}.${ext}`;
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

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: draftKey }));
    } catch (error) {
      logger.warn('Failed to delete draft image after approval', { error, id, type });
    }

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
