import type { PlaceLocationModel } from './location';
import type { OfferModel } from './offer';

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
  website?: string;
  locations?: PlaceLocationModel[];
  offers?: OfferModel[];
  status: PlaceStatus;
  reason: string;
  published: boolean;
}

/**
 * DynamoDB item shape — PK=PLACE#<id>, SK=METADATA.
 * GSI1PK is present only when published (sparse index) — powers the public listing.
 * GSI2PK is always 'PLACE' — powers the admin "all"/"unpublished" listing, which has no visibility gate.
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
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

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
  website: item.website || undefined,
  locations,
  offers,
  status: item.status,
  reason: item.reason,
  published: item.published,
});
