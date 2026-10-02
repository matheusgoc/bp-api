import type { APIGatewayProxyResult } from 'aws-lambda';

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

export const badRequest = (message: string) => json(400, { error: message });
export const unauthorized = (message = 'Authentication required') => json(401, { error: message });
export const forbidden = (message = 'Forbidden') => json(403, { error: message });
export const notFound = (message = 'Not found') => json(404, { error: message });
export const conflict = (message: string) => json(409, { error: message });
export const serverError = () => json(500, { error: 'Internal server error' });
