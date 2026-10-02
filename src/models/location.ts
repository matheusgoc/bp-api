export interface LocationWorkingHours {
  weekDay: string;
  start: string;
  end: string;
}

export interface PlaceLocationModel {
  id: string;
  name: string;
  city: string;
  state: string;
  address: string;
  postalCode: string;
  lat?: number;
  lon?: number;
  phone?: string;
  isWhatsapp?: boolean;
  email?: string;
  workingHours: LocationWorkingHours[];
  // only present (true) on soft-deleted locations, which are returned solely
  // by GET /places/{id}?deleted=true
  deleted?: true;
}

export const LOCATION_SK_PREFIX = 'LOCATION#';

/**
 * DynamoDB item shape — PK=PLACE#<placeId>, SK=LOCATION#<id>.
 * Lives in the same partition as its place's METADATA item, so 
 * place preview fetches the place and all its locations with a single Query on PK.
 * No GSI attributes — locations never show up in the place listings.
 */
export interface LocationItem {
  PK: string;
  SK: string;
  id: string;
  placeId: string;
  name: string;
  city: string;
  state: string;
  address: string;
  postalCode: string;
  lat: number | null;
  lon: number | null;
  phone: string;
  isWhatsapp: boolean;
  email: string;
  workingHours: LocationWorkingHours[];
  deleted: boolean;
  deletedAt: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export const locationKey = (placeId: string, id: string) => ({
  PK: `PLACE#${placeId}`,
  SK: `${LOCATION_SK_PREFIX}${id}`,
});

export const toLocationModel = (
  item: Omit<LocationItem, 'PK' | 'SK' | 'placeId' | 'deletedAt' | 'createdAt' | 'createdBy' | 'updatedAt'>,
): PlaceLocationModel => ({
  id: item.id,
  name: item.name,
  city: item.city,
  state: item.state,
  address: item.address,
  postalCode: item.postalCode,
  lat: item.lat ?? undefined,
  lon: item.lon ?? undefined,
  phone: item.phone || undefined,
  isWhatsapp: item.isWhatsapp,
  email: item.email || undefined,
  workingHours: item.workingHours ?? [],
  ...(item.deleted ? { deleted: true as const } : {}),
});
