import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '../../lib/powertools';
import { BUCKET_NAME, s3 } from '../../lib/s3';

export type PlaceImageType = 'photo' | 'logo';

// A fresh object key for every upload and approval, versioned by timestamp, so a new image always
// gets a new URL — no client or cache can keep showing an older image's bytes under the same URL
//   draft: places/{id}/{type}-draft-{version}.{ext}   live: places/{id}/{type}-{version}.{ext}
export const placeImageKey = (
  placeId: string,
  type: PlaceImageType,
  ext: string,
  draft: boolean,
): string => `places/${placeId}/${type}${draft ? '-draft' : ''}-${Date.now()}.${ext}`;

// The S3 key behind a stored image URL: its file name, under the place's own folder — works for
// any URL base (AWS, MinIO, pre-versioning keys), and a stored URL can never point a copy or delete
// outside the place's folder. Undefined when the URL has no file name.
export const placeImageKeyFromUrl = (placeId: string, url: string): string | undefined => {
  const fileName = url.slice(url.lastIndexOf('/') + 1);
  return fileName ? `places/${placeId}/${fileName}` : undefined;
};

// Removes an image object nothing references anymore — best effort, since a leftover object only
// costs storage, so a failure is logged rather than failing the request
export const deletePlaceImage = async (key: string): Promise<void> => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  } catch (error) {
    logger.warn('Failed to delete a replaced place image', { error, key });
  }
};
