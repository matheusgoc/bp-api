import { badRequestError } from '../../src/lib/errors';
import { badRequest } from '../../src/lib/http';

describe('badRequest', () => {
  it('returns a 400 with the dictionary code, message and field', () => {
    const result = badRequest('FIELD_INVALID', 'lat', 'must be a number between -90 and 90');

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      code: 'FIELD_INVALID',
      field: 'lat',
      msg: '"lat" must be a number between -90 and 90',
    });
  });

  it('passes through an error a validator already built', () => {
    const error = badRequestError('FIELD_REQUIRED', 'title');

    const result = badRequest(error);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      code: 'FIELD_REQUIRED',
      field: 'title',
      msg: '"title" is required',
    });
  });

  it('omits field for errors not tied to one input', () => {
    const result = badRequest('INVALID_JSON');

    expect(JSON.parse(result.body)).toEqual({
      code: 'INVALID_JSON',
      msg: 'Request body must be valid JSON',
    });
  });
});

describe('badRequestError', () => {
  it('builds the error body without a response, for validators', () => {
    expect(badRequestError('PATH_PARAMETER_REQUIRED', 'offerId')).toEqual({
      code: 'PATH_PARAMETER_REQUIRED',
      field: 'offerId',
      msg: '"offerId" path parameter is required',
    });
  });
});
