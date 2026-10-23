// Cursor pagination shared by the listing endpoints — DynamoDB's native
// Limit/LastEvaluatedKey, so each request reads only `take` items.

const DEFAULT_TAKE = 20;
const MAX_TAKE = 100;

// ?take — page size, default 20, capped at 100
export const parseTake = (value: string | undefined): { take: number } | { error: string } => {
  if (value === undefined) return { take: DEFAULT_TAKE };
  const take = Number(value);
  if (!Number.isInteger(take) || take < 1) return { error: '"take" must be a positive integer' };
  if (take > MAX_TAKE) return { error: `"take" must not exceed ${MAX_TAKE}` };
  return { take };
};

// generates a base64url pagination cursor wrapping DynamoDB's own LastEvaluatedKey
// tied to the query it was issued for - a listing filter, a place id 
// so it can't be replayed against a different one
export const encodeCursor = (filter: string, key: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify({ filter, key })).toString('base64url');

// decodes the cursor to retrieve the key — undefined when malformed or issued for another query
export const decodeCursor = (
  cursor: string,
  filter: string,
): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed.filter !== filter || typeof parsed.key !== 'object' || parsed.key === null) {
      return undefined;
    }
    return parsed.key as Record<string, unknown>;
  } catch {
    return undefined;
  }
};
