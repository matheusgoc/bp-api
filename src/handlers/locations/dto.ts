import type { LocationWorkingHours } from '../../models/location';

export interface LocationFields {
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
}

export type ParseLocationResult = { fields: LocationFields } | { error: string };

const REQUIRED = ['name', 'city', 'state', 'address', 'postalCode'] as const;
const OPTIONAL_STRINGS = ['phone', 'email'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const parseCoordinate = (
  name: 'lat' | 'lon',
  value: unknown,
  limit: number,
): { value: number | null } | { error: string } => {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) {
    return { error: `"${name}" must be a number between -${limit} and ${limit}` };
  }
  return { value };
};

// Validates a full PlaceLocationModel body (shared by add and update — update
// is a full replacement). Unknown fields are ignored.
export const parseLocationDto = (body: unknown): ParseLocationResult => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const dto = body as Record<string, unknown>;

  for (const field of REQUIRED) {
    if (!isNonEmptyString(dto[field])) return { error: `"${field}" is required` };
  }

  for (const field of OPTIONAL_STRINGS) {
    if (dto[field] !== undefined && typeof dto[field] !== 'string') {
      return { error: `"${field}" must be a string` };
    }
  }

  if (dto.isWhatsapp !== undefined && typeof dto.isWhatsapp !== 'boolean') {
    return { error: '"isWhatsapp" must be a boolean' };
  }

  const lat = parseCoordinate('lat', dto.lat, 90);
  if ('error' in lat) return lat;
  const lon = parseCoordinate('lon', dto.lon, 180);
  if ('error' in lon) return lon;

  if (!Array.isArray(dto.workingHours)) return { error: '"workingHours" must be an array' };

  const workingHours: LocationWorkingHours[] = [];
  for (const [index, entry] of dto.workingHours.entries()) {
    const hours = (entry ?? {}) as Record<string, unknown>;
    if (!isNonEmptyString(hours.weekDay)) {
      return { error: `"workingHours[${index}].weekDay" is required` };
    }
    for (const key of ['start', 'end'] as const) {
      if (typeof hours[key] !== 'string' || !TIME.test(hours[key] as string)) {
        return { error: `"workingHours[${index}].${key}" must be a time in HH:mm format` };
      }
    }
    workingHours.push({
      weekDay: hours.weekDay.trim(),
      start: hours.start as string,
      end: hours.end as string,
    });
  }

  return {
    fields: {
      name: (dto.name as string).trim(),
      city: (dto.city as string).trim(),
      state: (dto.state as string).trim(),
      address: (dto.address as string).trim(),
      postalCode: (dto.postalCode as string).trim(),
      lat: lat.value,
      lon: lon.value,
      phone: ((dto.phone as string | undefined) ?? '').trim(),
      isWhatsapp: (dto.isWhatsapp as boolean | undefined) ?? false,
      email: ((dto.email as string | undefined) ?? '').trim(),
      workingHours,
    },
  };
};
