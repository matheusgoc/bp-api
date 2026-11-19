import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { requirePlaceAccess } from '../../lib/access';
import { batchGetAll } from '../../lib/dynamo';
import { badRequest, json, serverError } from '../../lib/http';
import { logger } from '../../lib/powertools';
import { canManagePlace } from '../../models/place';
import { PlaceOwnerModel, toPlaceOwnerModel, UserItem } from '../../models/user';

/**
 * List Place Owners
 *
 * GET /places/{id}/owners (Cognito-protected, place owner/admin only)
 * The place's current owners other than the caller, in the order they were granted
 * (the creator first). Not paginated: ownerBy stays small.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  logger.addContext(context);

  const id = event.pathParameters?.id;
  if (!id) return badRequest('PATH_PARAMETER_REQUIRED', 'id');

  try {
    const access = await requirePlaceAccess(event, id);
    if ('response' in access) return access.response;
    const { user, place } = access;

    const ownerIds = (place.ownerBy ?? []).filter((ownerId) => ownerId !== user.id);
    if (!ownerIds.length) return json(200, { data: [] });

    const items = (await batchGetAll(
      ownerIds.map((ownerId) => ({ PK: `USER#${ownerId}`, SK: 'METADATA' })),
    )) as unknown as UserItem[];
    const byId = new Map(items.map((item) => [item.id, item]));

    // BatchGet answers in no particular order, so follow ownerBy's; an owner later
    // converted back to customer is still listed there but no longer manages the place
    const data: PlaceOwnerModel[] = ownerIds
      .map((ownerId) => byId.get(ownerId))
      .filter((owner): owner is UserItem => !!owner && canManagePlace(owner, place))
      .map(toPlaceOwnerModel);

    return json(200, { data });
  } catch (error) {
    logger.error('Failed to list place owners', error as Error);
    return serverError();
  }
};
