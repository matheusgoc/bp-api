import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { BUCKET_NAME, PUBLIC_URL_BASE, s3Presign } from '../../lib/s3';
import { badRequest, json, notFound, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';

interface UploadImageDto {
  contentType: string;
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const UPLOAD_EXPIRES_IN = 300; // seconds

/**
 * Upload Place Image
 *
 * PATCH /places/{id}/images/{type} (Cognito-protected)
 * {type} is 'photo' or 'logo', uploaded separately (one call per type).
 * Issues a short-lived presigned S3 PUT URL for the Expo app to upload
 * directly to a *draft* object key, and writes the resulting URL to
 * draftPhoto/draftLogo — optimistic, before the client's S3 PUT actually
 * completes. The live photo/logo field is only updated by a subsequent
 * PATCH .../images/{type}/approve call, which also moves the S3 object to
 * its live key — see approveImage.ts.
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

  let dto: UploadImageDto;
  try {
    dto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const contentType = dto.contentType;
  const ext = contentType ? CONTENT_TYPE_EXTENSIONS[contentType] : undefined;
  if (!ext) {
    return badRequest(
      `"contentType" must be one of: ${Object.keys(CONTENT_TYPE_EXTENSIONS).join(', ')}`,
    );
  }

  const draftField = type === 'photo' ? 'draftPhoto' : 'draftLogo';
  const key = `places/${id}/${type}-draft.${ext}`;
  const draftUrl = `${PUBLIC_URL_BASE}/${key}`;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PLACE#${id}`, SK: 'METADATA' },
        UpdateExpression: `SET ${draftField} = :url, updatedAt = :updatedAt`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':url': draftUrl,
          ':updatedAt': new Date().toISOString(),
        },
      }),
    );

    const uploadUrl = await getSignedUrl(
      s3Presign,
      new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_EXPIRES_IN },
    );

    logger.info('Issued presigned upload URL', { id, type });
    return json(200, { uploadUrl, draftUrl, expiresIn: UPLOAD_EXPIRES_IN });
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Place not found');
    }
    logger.error('Failed to issue presigned upload URL', error as Error);
    return serverError();
  }
};
