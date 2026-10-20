import type { LocationItem, PlaceLocationModel } from './location';
import type { PlaceItem, PlaceModel } from './place';

export enum OfferStatus {
  ACTIVE = 'active',
  CANCELED = 'canceled',
  // derived, never stored — an active offer whose end has been reached
  EXPIRED = 'expired',
}

export type StoredOfferStatus = OfferStatus.ACTIVE | OfferStatus.CANCELED;

export interface OfferModel {
  id: string;
  title: string;
  discount?: number;
  start?: string;
  end?: string;
  status: OfferStatus;
  // returned by the offers endpoints; omitted on offers nested in a place/location
  // preview, since the parent already carries them
  place?: Pick<PlaceModel, 'id' | 'name' | 'logo'>;
  location?: Pick<PlaceLocationModel, 'id' | 'name' | 'city' | 'state'>;
}

// GSI1SK of an offer with no end — sorts after every real ISO timestamp, so the
// live-offers query (GSI1SK > now) always includes it
export const NO_END_SORT_KEY = '9999-12-31T23:59:59.999Z';

/**
 * DynamoDB item shape — PK=OFFER#<id>, SK=METADATA.
 * Deliberately outside its place's partition (unlike locations): offers are never
 * deleted, so they'd pile up in the partition place preview reads whole.
 * GSI1PK is present only while status is active (sparse index) and GSI1SK holds the
 * end — powers the previews' live-offers query, which skips expired ones by key.
 * GSI2PK/GSI2SK are always present — power the paginated, newest-first offers list.
 * locationId is '' for a place-level offer.
 */
export interface OfferItem {
  PK: string;
  SK: 'METADATA';
  GSI1PK?: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
  id: string;
  placeId: string;
  locationId: string;
  title: string;
  discount: number | null;
  start: string;
  end: string;
  status: StoredOfferStatus;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export const offerKey = (id: string) => ({ PK: `OFFER#${id}`, SK: 'METADATA' as const });

// GSI1PK — the place's active offers (sparse)
export const activeOffersKey = (placeId: string): string => `OFFER#ACTIVE#PLACE#${placeId}`;

// GSI2PK — all of the place's offers
export const placeOffersKey = (placeId: string): string => `OFFER#PLACE#${placeId}`;

export const offerEndSortKey = (end: string): string => end || NO_END_SORT_KEY;

// "expired" is never stored: an active offer shows as expired once its end has been reached
export const offerStatus = (item: Pick<OfferItem, 'status' | 'end'>, now: Date): OfferStatus =>
  item.status === OfferStatus.ACTIVE && !!item.end && Date.parse(item.end) <= now.getTime()
    ? OfferStatus.EXPIRED
    : item.status;

// shown on place/location previews: active, not expired, and already started
export const isOfferVisible = (
  item: Pick<OfferItem, 'status' | 'start' | 'end'>,
  now: Date,
): boolean =>
  offerStatus(item, now) === OfferStatus.ACTIVE &&
  (!item.start || Date.parse(item.start) <= now.getTime());

export const toOfferModel = (
  item: OfferItem,
  now: Date,
  refs: { place?: PlaceItem; location?: LocationItem } = {},
): OfferModel => ({
  id: item.id,
  title: item.title,
  discount: item.discount ?? undefined,
  start: item.start || undefined,
  end: item.end || undefined,
  status: offerStatus(item, now),
  place: refs.place && {
    id: refs.place.id,
    name: refs.place.name,
    logo: refs.place.logo || undefined,
  },
  location: refs.location && {
    id: refs.location.id,
    name: refs.location.name,
    city: refs.location.city,
    state: refs.location.state,
  },
});
