import type { APIGatewayProxyEvent } from 'aws-lambda';
import { resolveExternalId } from '../../src/lib/auth';

const eventWith = (claimsSub?: string) =>
  ({
    headers: {},
    requestContext: claimsSub ? { authorizer: { claims: { sub: claimsSub } } } : {},
  }) as unknown as APIGatewayProxyEvent;

describe('resolveExternalId (prod — DYNAMODB_ENDPOINT unset)', () => {
  it('uses Gateway-verified claims.sub when present', async () => {
    const result = await resolveExternalId(eventWith('gw-sub'));
    expect(result).toEqual({ externalId: 'gw-sub' });
  });

  it('returns unauthorized when claims.sub is missing', async () => {
    const result = await resolveExternalId(eventWith());
    expect(result).toEqual({ error: 'unauthorized' });
  });
});
