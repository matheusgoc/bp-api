import { S3Client } from '@aws-sdk/client-s3';
import { tracer } from './powertools';

// SDK versions after Dec 2024 default to computing a CRC32 checksum on every
// eligible request, which would also bake a checksum requirement into
// presigned URLs — forcing every uploader to compute and send a matching
// header. Opt back into the classic (pre-default-change) behavior so a
// plain PUT with just a Content-Type header works, and so MinIO (which
// doesn't implement the checksum headers) doesn't reject bucket-admin calls.
const commonConfig = {
  requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  responseChecksumValidation: 'WHEN_REQUIRED' as const,
};

const localCredentials = { accessKeyId: 'local', secretAccessKey: 'local12345' };

// Real S3 client, used for calls the Lambda itself makes over the network
// (CopyObject, DeleteObject, ...). Locally this must be reachable from
// *inside* the SAM/docker network — S3_ENDPOINT=http://minio:9000, mirroring
// DYNAMODB_ENDPOINT=http://dynamodb:8000.
const client = new S3Client({
  ...commonConfig,
  ...(process.env.S3_ENDPOINT
    ? {
        endpoint: process.env.S3_ENDPOINT,
        region: 'local',
        credentials: localCredentials,
        forcePathStyle: true, // MinIO needs path-style addressing (bucket in path, not subdomain)
      }
    : {}),
});

// X-Ray instrumentation (no-op when tracing is disabled, e.g. locally)
tracer.captureAWSv3Client(client);

export const s3 = client;

// Presign-only client, used exclusively for getSignedUrl(). Unlike the real
// client above, the resulting URL is handed to an *external* caller (the
// Expo app / curl) that sits outside the docker network — so locally this
// must point at a host-reachable endpoint instead, S3_PRESIGN_ENDPOINT=
// http://localhost:9000. getSignedUrl() never makes a network call itself
// (offline SigV4 signing), so this client's `endpoint` is the only thing
// that matters about it; in AWS neither env var is set, so both clients
// resolve to the same real S3 endpoint.
export const s3Presign = process.env.S3_PRESIGN_ENDPOINT
  ? new S3Client({
      ...commonConfig,
      endpoint: process.env.S3_PRESIGN_ENDPOINT,
      region: 'local',
      credentials: localCredentials,
      forcePathStyle: true,
    })
  : client;

export const BUCKET_NAME = process.env.BUCKET_NAME ?? '';
export const PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE ?? '';
