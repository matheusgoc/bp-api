import type { APIGatewayProxyEvent } from 'aws-lambda';

// Must be set before importing src/lib/auth — isLocal is computed at module load.
process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000';

import { resolveExternalId } from '../../src/lib/auth';

const eventWith = (authorization?: string, claimsSub?: string) =>
  ({
    headers: authorization ? { Authorization: authorization } : {},
    requestContext: claimsSub ? { authorizer: { claims: { sub: claimsSub } } } : {},
  }) as unknown as APIGatewayProxyEvent;

const fakeToken = (payload: unknown) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

describe('resolveExternalId (local — SAM local, no real Cognito)', () => {
  it('uses Gateway-verified claims.sub when present', async () => {
    const result = await resolveExternalId(eventWith(undefined, 'gw-sub'));
    expect(result).toEqual({ externalId: 'gw-sub' });
  });

  it('falls back to local-dev when no token is present', async () => {
    const result = await resolveExternalId(eventWith());
    expect(result).toEqual({ externalId: 'local-dev' });
  });

  it('decodes the sub from an unsigned token without verifying it', async () => {
    const result = await resolveExternalId(eventWith(`Bearer ${fakeToken({ sub: 'local-sub' })}`));
    expect(result).toEqual({ externalId: 'local-sub' });
  });

  it('falls back to local-dev for a malformed token', async () => {
    const result = await resolveExternalId(eventWith('Bearer not-a-jwt'));
    expect(result).toEqual({ externalId: 'local-dev' });
  });
});
