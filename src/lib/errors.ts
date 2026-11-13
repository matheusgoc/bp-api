// Dictionary of 400 Bad Request errors. Each key is the stable `code` the app
// matches on; each value builds the human-readable `msg` and, when the error is
// about one specific input, the `field` (body field or path/query parameter).
// A new 400 case means a new entry here — never a free-text message at the call site.
export const BAD_REQUEST = {
  // request shape
  INVALID_JSON: () => ({ msg: 'Request body must be valid JSON' }),
  INVALID_BODY: (rule: string) => ({ msg: `Request body ${rule}` }),
  PATH_PARAMETER_REQUIRED: (param: string) => ({
    field: param,
    msg: `"${param}" path parameter is required`,
  }),
  // path or query parameter
  PARAMETER_INVALID: (param: string, rule: string) => ({ field: param, msg: `"${param}" ${rule}` }),
  INVALID_CURSOR: () => ({ field: 'cursor', msg: '"cursor" is invalid' }),

  // body fields
  FIELD_REQUIRED: (field: string) => ({ field, msg: `"${field}" is required` }),
  // an optional field sent blank on a partial update
  FIELD_EMPTY: (field: string) => ({ field, msg: `"${field}" cannot be empty` }),
  FIELD_INVALID: (field: string, rule: string) => ({ field, msg: `"${field}" ${rule}` }),

  // business rules
  PLACE_NOT_APPROVED: () => ({
    msg: 'Place must be approved (status "active") before it can be published',
  }),
  CATEGORY_NOT_FOUND: () => ({ field: 'category', msg: '"category" does not exist' }),
  LOCATION_NOT_FOUND: () => ({ field: 'location', msg: '"location" does not exist' }),
  NO_PENDING_DRAFT_IMAGE: (type: string) => ({
    field: 'type',
    msg: `No pending draft "${type}" to approve`,
  }),
  DRAFT_IMAGE_NOT_UPLOADED: () => ({
    msg: 'Draft image was not found in storage — re-upload before approving',
  }),
  OWNER_ROLE_REQUIRED: () => ({
    field: 'owner',
    msg: '"owner" must be a user with the owner role',
  }),
  CANNOT_CONVERT_SELF: () => ({
    field: 'id',
    msg: '"id" must be another user, not the current one',
  }),
} satisfies Record<string, (...args: never[]) => { msg: string; field?: string }>;

export type BadRequestCode = keyof typeof BAD_REQUEST;
export type BadRequestArgs<C extends BadRequestCode> = Parameters<(typeof BAD_REQUEST)[C]>;

// 400 response body
export interface BadRequestError {
  code: BadRequestCode;
  msg: string;
  field?: string;
}

export const badRequestError = <C extends BadRequestCode>(
  code: C,
  ...args: BadRequestArgs<C>
): BadRequestError => {
  const build = BAD_REQUEST[code] as (...params: BadRequestArgs<C>) => {
    msg: string;
    field?: string;
  };
  return { code, ...build(...args) };
};
