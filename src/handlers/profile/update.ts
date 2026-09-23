import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { resolveExternalId } from '../../lib/auth';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, json, notFound, serverError, unauthorized } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { Gender, UserItem, toUserModel, userExternalIdKey } from '../../models/user';

interface ProfileDto {
  name?: string;
  phone?: string;
  isWhatsapp?: boolean;
  dob?: string;
  gender?: Gender;
}

const TRIMMED_FIELDS: Array<'name' | 'phone' | 'dob'> = ['name', 'phone', 'dob'];
const VALID_GENDERS: Gender[] = ['M', 'F', 'N', 'O', 'U', ''];

/**
 * Update Profile
 *
 * PUT /profile (Cognito-protected)
 * Updates the current user's own name/email/phone/dob/gender/isWhatsapp.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const auth = await resolveExternalId(event);
  if ('error' in auth) return unauthorized();
  const { externalId } = auth;

  let profileDto: ProfileDto;
  try {
    profileDto = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  if (profileDto.gender !== undefined && !VALID_GENDERS.includes(profileDto.gender)) {
    return badRequest(`"gender" must be one of: ${VALID_GENDERS.join(', ')}`);
  }
  if (profileDto.isWhatsapp !== undefined && typeof profileDto.isWhatsapp !== 'boolean') {
    return badRequest('"isWhatsapp" must be a boolean');
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  for (const field of TRIMMED_FIELDS) {
    const value = profileDto[field];
    if (value === undefined) continue;
    if (!value.trim()) return badRequest(`"${field}" cannot be empty`);

    names[`#${field}`] = field;
    values[`:${field}`] = value.trim();
    sets.push(`#${field} = :${field}`);
  }

  if (profileDto.gender !== undefined) {
    names['#gender'] = 'gender';
    values[':gender'] = profileDto.gender;
    sets.push('#gender = :gender');
  }

  if (profileDto.isWhatsapp !== undefined) {
    names['#isWhatsapp'] = 'isWhatsapp';
    values[':isWhatsapp'] = profileDto.isWhatsapp;
    sets.push('#isWhatsapp = :isWhatsapp');
  }

  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();
  sets.push('#updatedAt = :updatedAt');

  try {
    const existing = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': userExternalIdKey(externalId) },
        Limit: 1,
      }),
    );

    const own = existing.Items?.[0] as UserItem | undefined;
    if (!own) return notFound('Profile not found');

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: own.PK, SK: own.SK },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Profile updated', { id: own.id });
    return json(200, toUserModel(result.Attributes as UserItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return notFound('Profile not found');
    }
    logger.error('Failed to update profile', error as Error);
    return serverError();
  }
};
