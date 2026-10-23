import { placeImageKey, placeImageKeyFromUrl } from '../../../src/handlers/places/images';

describe('place image keys', () => {
  it('versions every key, so each upload or approval gets a new URL', () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1700000000000).mockReturnValueOnce(1700000000001);

    expect(placeImageKey('p1', 'photo', 'jpg', true)).toBe('places/p1/photo-draft-1700000000000.jpg');
    expect(placeImageKey('p1', 'logo', 'png', false)).toBe('places/p1/logo-1700000000001.png');
  });

  it.each([
    ['http://localhost:9000/bp-api-local/places/p1/photo-draft-1.jpg', 'places/p1/photo-draft-1.jpg'],
    ['https://bucket.s3.us-east-1.amazonaws.com/places/p1/logo-2.png', 'places/p1/logo-2.png'],
    ['http://localhost:9000/bp-api-local/places/p1/photo-draft.jpg', 'places/p1/photo-draft.jpg'],
    // a stored URL can't point outside the place's own folder
    ['https://bucket.s3.amazonaws.com/places/other/photo-1.jpg', 'places/p1/photo-1.jpg'],
  ])('resolves %s to its key under the place folder', (url, key) => {
    expect(placeImageKeyFromUrl('p1', url)).toBe(key);
  });

  it('returns undefined for a URL with no file name', () => {
    expect(placeImageKeyFromUrl('p1', 'https://bucket.s3.amazonaws.com/places/p1/')).toBeUndefined();
  });
});
