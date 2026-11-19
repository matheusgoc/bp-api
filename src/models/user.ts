export enum UserRole {
  CUSTOMER = 'customer',
  OWNER = 'owner',
  ADMIN = 'admin',
}

export enum SubscriptionStatus {
  SUCCESS = 'success',
  PENDING = 'pending',
  NOT_APPLIED = 'not_applied',
}

export type Gender = 'M' | 'F' | 'N' | 'O' | 'U' | '';

export interface UserModel {
  id: string;
  name: string;
  email: string;
  phone?: string;
  isWhatsapp?: boolean;
  dob?: string;
  gender?: Gender;
  role: UserRole;
  subscriptionStatus: SubscriptionStatus;
}

// The public summary of an owner, shown to the other owners of a place (owner search and
// the place's owners list) — deliberately without phone/dob/gender/subscription
export interface PlaceOwnerModel {
  id: string;
  name: string;
  email: string;
}

/**
 * DynamoDB item shape — PK=USER#<id>, SK=METADATA.
 * GSI1PK/GSI1SK are a unique lookup index by externalId (the Cognito sub) —
 * the app-level `id` is deliberately its own generated value, decoupled from
 * the auth provider's identifier, since admin conversion targets another
 * user by app-level id, not by Cognito sub.
 * GSI2PK/GSI2SK are a lookup index by email (trimmed, lowercased), written at signup.
 */
export interface UserItem {
  PK: string;
  SK: 'METADATA';
  GSI1PK: string;
  GSI1SK: 'METADATA';
  GSI2PK: string;
  GSI2SK: 'METADATA';
  id: string;
  externalId: string;
  name: string;
  email: string;
  phone: string;
  isWhatsapp: boolean;
  dob: string;
  gender: Gender;
  role: UserRole;
  subscriptionStatus: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export const userExternalIdKey = (externalId: string): string => `USER#EXTERNAL#${externalId}`;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const userEmailKey = (email: string): string => `USER#EMAIL#${normalizeEmail(email)}`;

export const toPlaceOwnerModel = (item: UserItem): PlaceOwnerModel => ({
  id: item.id,
  name: item.name,
  email: item.email,
});

export const toUserModel = (item: UserItem): UserModel => ({
  id: item.id,
  name: item.name,
  email: item.email,
  phone: item.phone || undefined,
  isWhatsapp: item.isWhatsapp,
  dob: item.dob || undefined,
  gender: item.gender || undefined,
  role: item.role,
  subscriptionStatus: item.subscriptionStatus,
});
