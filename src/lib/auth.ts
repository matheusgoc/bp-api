import type { APIGatewayProxyEvent } from 'aws-lambda';

const isLocal = !!process.env.DYNAMODB_ENDPOINT;

const extractBearerToken = (event: APIGatewayProxyEvent): string | undefined => {
  const header = event.headers?.Authorization ?? event.headers?.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
};

// Decodes (without verifying) a JWT's payload — used only in local dev, where
// there's no real Cognito user pool to verify against. Lets local testing
// exercise multiple distinct users by crafting different fake tokens.
const decodeUnverifiedSub = (token: string): string | undefined => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload?.sub === 'string' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
};

export type ResolveExternalIdResult = { externalId: string } | { error: 'unauthorized' };

// Resolves the caller's Cognito externalId (sub). Every profile route has a
// Gateway Cognito authorizer, so claims.sub is always populated in prod; the
// manual token decode below only exists to support SAM local, where the
// authorizer isn't enforced.
export const resolveExternalId = async (
  event: APIGatewayProxyEvent,
): Promise<ResolveExternalIdResult> => {
  const claimsSub = event.requestContext.authorizer?.claims?.sub;
  if (claimsSub) return { externalId: claimsSub };

  if (!isLocal) return { error: 'unauthorized' };

  const token = extractBearerToken(event);
  if (!token) return { externalId: 'local-dev' };

  const sub = decodeUnverifiedSub(token);
  return { externalId: sub ?? 'local-dev' };
};
