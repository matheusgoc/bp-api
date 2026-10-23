import type { PlaceLocationModel } from './location';
import type { OfferModel } from './offer';
import { UserItem, UserRole } from './user';

export enum PlaceStatus {
  DRAFT = 'draft',
  REVIEWING = 'reviewing',
  ACTIVE = 'active',
  PENDING = 'pending',
  BLOCKED = 'blocked',
}

export interface PlaceModel {
  id: string;
  name: string;
  description?: string;
  category: { id: string };
  photo: string;
  logo?: string;
  // pending uploads, not yet approved — for the owner/admin management view only
  draftPhoto?: string;
  draftLogo?: string;
  website?: string;
  locations?: PlaceLocationModel[];
  offers?: OfferModel[];
  status: PlaceStatus;
  reason: string;
  published: boolean;
}

/**
 * DynamoDB item shape — PK=PLACE#<id>, SK=METADATA
 * GSI1PK is present only when published (sparse index) — powers the public listing
 * GSI2PK is always 'PLACE' — powers the admin "all"/"unpublished" listing, which has no visibility gate
 * ownerBy holds the app-level ids of the users who own the place — internal only, never in PlaceModel
 */
export interface PlaceItem {
  PK: string;
  SK: 'METADATA';
  GSI1PK?: 'PLACE#PUBLISHED';
  GSI1SK: string;
  GSI2PK: 'PLACE';
  GSI2SK: string;
  id: string;
  name: string;
  description: string;
  category: string;
  photo: string;
  logo: string;
  draftPhoto: string;
  draftLogo: string;
  website: string;
  status: PlaceStatus;
  reason: string;
  published: boolean;
  ownerBy: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/**
 * Ownership index item — PK=USER#<userId>, SK=PLACE#<placeCreatedAt>#<placeId>
 * Mirrors one entry of the place's ownerBy
 * so an owner's places can be listed newest first with a plain base-table Query 
 * Always written in the same transaction as the ownerBy change
 */
export interface PlaceOwnershipItem {
  PK: string;
  SK: string;
  placeId: string;
  userId: string;
  createdAt: string;
  createdBy: string;
}

export const PLACE_OWNERSHIP_SK_PREFIX = 'PLACE#';

export const placeOwnershipKey = (
  userId: string,
  place: Pick<PlaceItem, 'id' | 'createdAt'>,
): { PK: string; SK: string } => ({
  PK: `USER#${userId}`,
  SK: `${PLACE_OWNERSHIP_SK_PREFIX}${place.createdAt}#${place.id}`,
});

export const PLACE_ACCESS_DENIED = 'Not an owner of this place';

// Admins manage every place; owners only the ones listing them in ownerBy 
// absent on places created before ownership existed — admin-only until granted
// Anyone else — e.g. an owner
// later converted back to customer, still listed — is denied
export const canManagePlace = (
  user: Pick<UserItem, 'id' | 'role'>,
  place: Pick<PlaceItem, 'ownerBy'>,
): boolean =>
  user.role === UserRole.ADMIN ||
  (user.role === UserRole.OWNER && (place.ownerBy ?? []).includes(user.id));

export const toPlaceModel = (
  item: PlaceItem,
  locations?: PlaceLocationModel[],
  offers?: OfferModel[],
): PlaceModel => ({
  id: item.id,
  name: item.name,
  description: item.description || undefined,
  category: { id: item.category },
  photo: item.photo,
  logo: item.logo || undefined,
  draftPhoto: item.draftPhoto || undefined,
  draftLogo: item.draftLogo || undefined,
  website: item.website || undefined,
  locations,
  offers,
  status: item.status,
  reason: item.reason,
  published: item.published,
});
