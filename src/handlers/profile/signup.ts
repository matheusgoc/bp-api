import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { resolveExternalId } from '../../lib/auth';
import { ddb, TABLE_NAME } from '../../lib/dynamo';
import { badRequest, conflict, json, serverError, unauthorized } from '../../lib/http';
import { logger, metrics } from '../../lib/powertools';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  Gender,
  SubscriptionStatus,
  UserItem,
  UserRole,
  toUserModel,
  userExternalIdKey,
} from '../../models/user';

interface ProfileDto {
  name: string;
  email: string;
  phone?: string;
  isWhatsapp?: boolean;
  dob?: string;
  gender?: Gender;
}

const VALID_GENDERS: Gender[] = ['M', 'F', 'N', 'O', 'U', ''];

/**
 * Sign Up
 *
 * POST /profile (JWT required)
 * Called by the mobile app after Amplify Cognito signup + confirmation + signin,
 * with the resulting access token. Creates a profile for the caller's Cognito
 * identity, resolved from the Gateway-verified claims via resolveExternalId().
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

  if (!profileDto.name?.trim()) return badRequest('"name" is required');
  if (!profileDto.email?.trim()) return badRequest('"email" is required');
  if (profileDto.gender !== undefined && !VALID_GENDERS.includes(profileDto.gender)) {
    return badRequest(`"gender" must be one of: ${VALID_GENDERS.join(', ')}`);
  }
  if (profileDto.isWhatsapp !== undefined && typeof profileDto.isWhatsapp !== 'boolean') {
    return badRequest('"isWhatsapp" must be a boolean');
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();

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
    if (existing.Items?.length) {
      return conflict('Profile already exists');
    }

    const item: UserItem = {
      PK: `USER#${id}`,
      SK: 'METADATA',
      GSI1PK: userExternalIdKey(externalId),
      GSI1SK: 'METADATA',
      id,
      externalId,
      name: profileDto.name.trim(),
      email: profileDto.email.trim(),
      phone: profileDto.phone?.trim() ?? '',
      isWhatsapp: profileDto.isWhatsapp ?? false,
      dob: profileDto.dob?.trim() ?? '',
      gender: profileDto.gender ?? '',
      role: UserRole.CUSTOMER,
      subscriptionStatus: SubscriptionStatus.NOT_APPLIED,
      createdAt,
      updatedAt: createdAt,
    };

    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

    metrics.addMetric('ProfileCreated', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    logger.info('Profile created', { id });

    return json(201, toUserModel(item));
  } catch (error) {
    logger.error('Failed to create profile', error as Error);
    return serverError();
  }
};
