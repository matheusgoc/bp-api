import type { APIGatewayProxyResult } from 'aws-lambda';
import {
  badRequestError,
  type BadRequestArgs,
  type BadRequestCode,
  type BadRequestError,
} from './errors';

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const json = (
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult => ({
  statusCode,
  headers: BASE_HEADERS,
  body: JSON.stringify(body),
});

// 400s are coded — { code, msg, field? } from the BAD_REQUEST dictionary (./errors).
// Either a dictionary code with its arguments, e.g. badRequest('FIELD_REQUIRED', 'name'),
// or an error a validator already built with badRequestError(), passed through as is.
export function badRequest(error: BadRequestError): APIGatewayProxyResult;
export function badRequest<C extends BadRequestCode>(
  code: C,
  ...args: BadRequestArgs<C>
): APIGatewayProxyResult;
export function badRequest(
  codeOrError: BadRequestCode | BadRequestError,
  ...args: unknown[]
): APIGatewayProxyResult {
  if (typeof codeOrError !== 'string') return json(400, codeOrError);
  const build = badRequestError as (code: BadRequestCode, ...params: unknown[]) => BadRequestError;
  return json(400, build(codeOrError, ...args));
}
export const unauthorized = (message = 'Authentication required') => json(401, { error: message });
export const forbidden = (message = 'Forbidden') => json(403, { error: message });
export const notFound = (message = 'Not found') => json(404, { error: message });
export const conflict = (message: string) => json(409, { error: message });
export const serverError = () => json(500, { error: 'Internal server error' });
