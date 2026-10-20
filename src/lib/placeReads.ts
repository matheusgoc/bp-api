import { queryAll } from './dynamo';
import { LOCATION_SK_PREFIX, LocationItem } from '../models/location';
import { activeOffersKey, isOfferVisible, OfferItem } from '../models/offer';
import { PlaceItem } from '../models/place';

// A place's whole partition — its METADATA item plus every LOCATION# item — in one
// paginated Query. Stays small: offers live in their own items, outside the partition.
export const loadPlacePartition = async (
  placeId: string,
): Promise<{ place?: PlaceItem; locations: LocationItem[] }> => {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `PLACE#${placeId}` },
  });

  return {
    place: items.find((item) => item.SK === 'METADATA') as PlaceItem | undefined,
    locations: items.filter((item) =>
      String(item.SK).startsWith(LOCATION_SK_PREFIX),
    ) as unknown as LocationItem[],
  };
};

// The place's offers visible on previews (place-level and per location), newest first.
// GSI1 holds only active offers, keyed by end, so `GSI1SK > now` never reads canceled or
// expired ones; isOfferVisible then drops the ones that haven't started yet.
export const loadLiveOffers = async (placeId: string, now: Date): Promise<OfferItem[]> => {
  const items = (await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK > :now',
    ExpressionAttributeValues: { ':pk': activeOffersKey(placeId), ':now': now.toISOString() },
  })) as unknown as OfferItem[];

  return items
    .filter((item) => isOfferVisible(item, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
