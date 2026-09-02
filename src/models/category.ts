export interface CategoryModel {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  order: number;
}

/**
 * DynamoDB item shape — PK=CATEGORY#<id>, SK=METADATA.
 * GSI1PK is present only when enabled (sparse index) — powers the public listing.
 * GSI2PK is always 'CATEGORY' — powers the "disabled"/"all" listing, which has no visibility gate.
 * GSI1SK/GSI2SK hold categoryOrderSortKey(order) so both indexes list categories
 * ascending by `order` via the native key sort, with no application-side sorting needed.
 */
export interface CategoryItem {
  PK: string;
  SK: 'METADATA';
  GSI1PK?: 'CATEGORY#ENABLED';
  GSI1SK: string;
  GSI2PK: 'CATEGORY';
  GSI2SK: string;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  order: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/**
 * Zero-pads `order` so lexicographic (string) comparison matches numeric comparison —
 * required since GSI1SK/GSI2SK are DynamoDB String-type sort keys.
 */
export const categoryOrderSortKey = (order: number): string => String(order).padStart(15, '0');

export const toCategoryModel = (item: CategoryItem): CategoryModel => ({
  id: item.id,
  name: item.name,
  description: item.description || undefined,
  enabled: item.enabled,
  order: item.order,
});
