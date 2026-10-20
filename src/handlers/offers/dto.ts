import { OfferStatus, StoredOfferStatus } from '../../models/offer';

export interface OfferFields {
  title: string;
  discount: number | null;
  start: string;
  end: string;
}

export type ParseOfferResult =
  | { fields: OfferFields; status?: StoredOfferStatus }
  | { error: string };

// "expired" is derived from end, never settable
const STATUSES: StoredOfferStatus[] = [OfferStatus.ACTIVE, OfferStatus.CANCELED];

// ISO 8601 date-time with an explicit offset — a bare date would be read as UTC
// midnight, e.g. an end of "2026-10-31" would expire at 21:00 on the 30th in Brazil
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// normalized to UTC (toISOString), so stored dates compare correctly as strings
const parseDateTime = (
  name: 'start' | 'end',
  value: unknown,
): { value: string } | { error: string } => {
  if (value === undefined || value === null || value === '') return { value: '' };
  if (typeof value !== 'string' || !DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    return {
      error: `"${name}" must be an ISO 8601 date-time with a timezone offset (e.g. 2026-10-31T23:59:59-03:00)`,
    };
  }
  return { value: new Date(value).toISOString() };
};

// Validates an offer body (shared by add and update — update is a full replacement
// of the fields). status is optional on both. Unknown fields are ignored.
export const parseOfferDto = (body: unknown): ParseOfferResult => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const dto = body as Record<string, unknown>;

  const title = typeof dto.title === 'string' ? dto.title.trim() : '';
  if (!title) return { error: '"title" is required' };

  const { discount } = dto;
  if (
    discount !== undefined &&
    discount !== null &&
    (typeof discount !== 'number' || !Number.isFinite(discount) || discount <= 0)
  ) {
    return { error: '"discount" must be a positive number' };
  }

  const start = parseDateTime('start', dto.start);
  if ('error' in start) return start;
  const end = parseDateTime('end', dto.end);
  if ('error' in end) return end;
  if (start.value && end.value && end.value <= start.value) {
    return { error: '"end" must be after "start"' };
  }

  const status = dto.status as StoredOfferStatus | undefined;
  if (status !== undefined && !STATUSES.includes(status)) {
    return { error: `"status" must be one of ${STATUSES.map((s) => `"${s}"`).join(', ')}` };
  }

  return {
    fields: {
      title,
      discount: (discount as number | null | undefined) ?? null,
      start: start.value,
      end: end.value,
    },
    status,
  };
};
