const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  CreateBucketCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const config = require('./config');

const settings = config.objectStorage || {};
const remoteEnabled = Boolean(
  settings.backend === 's3' &&
  settings.endpoint &&
  settings.bucket &&
  settings.accessKeyId &&
  settings.secretAccessKey
);
const publicBaseUrl = resolvePublicBaseUrl();

let client;
let bucketReadyPromise;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolvePublicBaseUrl() {
  const explicit = String(settings.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;

  const endpoint = String(settings.endpoint || '').trim();
  const bucket = String(settings.bucket || '').trim();
  if (!endpoint || !bucket) return '';

  try {
    const normalizedEndpoint = /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
    const parsed = new URL(normalizedEndpoint);
    return `${parsed.protocol}//${bucket}.${parsed.host}`;
  } catch {
    return '';
  }
}

function createClient() {
  if (!remoteEnabled) return null;
  if (!client) {
    client = new S3Client({
      region: settings.region,
      endpoint: settings.endpoint,
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
    });
  }
  return client;
}

async function ensureBucketReady() {
  if (!remoteEnabled) return;
  if (bucketReadyPromise) return bucketReadyPromise;
  bucketReadyPromise = (async () => {
    const s3 = createClient();
    try {
      await s3.send(new HeadBucketCommand({ Bucket: settings.bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: settings.bucket }));
    }
    try {
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: settings.bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        })
      );
    } catch (error) {
      console.warn('object storage versioning setup failed:', error.message);
    }
  })();
  return bucketReadyPromise;
}

function keyForAsset(projectUuid, storedName) {
  const prefix = settings.prefix ? `${settings.prefix}/` : '';
  return `${prefix}${String(projectUuid)}/assets/${String(storedName)}`;
}

function publicUrlForKey(key) {
  if (!publicBaseUrl || !key) return '';
  const encodedKey = String(key)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${publicBaseUrl}/${encodedKey}`;
}

function publicUrlForAsset(projectUuid, storedName) {
  if (!storedName) return '';
  return publicUrlForKey(keyForAsset(projectUuid, storedName));
}

async function uploadLocalFile(projectUuid, storedName, filePath, contentType = 'application/octet-stream') {
  if (!remoteEnabled) return null;
  await ensureBucketReady();
  const s3 = createClient();
  await s3.send(
    new PutObjectCommand({
      Bucket: settings.bucket,
      Key: keyForAsset(projectUuid, storedName),
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
    })
  );
  return keyForAsset(projectUuid, storedName);
}

async function uploadBuffer(projectUuid, storedName, buffer, contentType = 'application/octet-stream') {
  if (!remoteEnabled) return null;
  await ensureBucketReady();
  const s3 = createClient();
  await s3.send(
    new PutObjectCommand({
      Bucket: settings.bucket,
      Key: keyForAsset(projectUuid, storedName),
      Body: buffer,
      ContentType: contentType,
    })
  );
  return keyForAsset(projectUuid, storedName);
}

async function createPresignedUpload(key, options = {}) {
  if (!remoteEnabled) throw new Error('Object storage is unavailable');
  await ensureBucketReady();
  const expiresSeconds = Math.max(30, Math.min(600, Number(options.expiresSeconds) || 180));
  const maxBytes = Math.max(1, Number(options.maxBytes) || 64 * 1024 * 1024);
  return createPresignedPost(createClient(), {
    Bucket: settings.bucket,
    Key: String(key),
    Expires: expiresSeconds,
    Fields: { success_action_status: '204' },
    Conditions: [['content-length-range', 1, maxBytes]],
  });
}

async function headKey(key) {
  if (!remoteEnabled) return null;
  await ensureBucketReady();
  return createClient().send(new HeadObjectCommand({ Bucket: settings.bucket, Key: String(key) }));
}

async function downloadKeyToLocal(key, localPath) {
  if (!remoteEnabled) return false;
  await ensureBucketReady();
  const response = await createClient().send(new GetObjectCommand({ Bucket: settings.bucket, Key: String(key) }));
  ensureDir(path.dirname(localPath));
  await pipeline(response.Body, fs.createWriteStream(localPath));
  return true;
}

async function deleteKey(key) {
  if (!remoteEnabled || !key) return;
  await ensureBucketReady();
  await createClient().send(
    new DeleteObjectsCommand({
      Bucket: settings.bucket,
      Delete: { Objects: [{ Key: String(key) }], Quiet: true },
    })
  );
}

async function copyAsset(sourceProjectUuid, sourceStoredName, targetProjectUuid, targetStoredName = sourceStoredName) {
  if (!remoteEnabled) return null;
  await ensureBucketReady();
  const s3 = createClient();
  const sourceKey = keyForAsset(sourceProjectUuid, sourceStoredName);
  const targetKey = keyForAsset(targetProjectUuid, targetStoredName);
  await s3.send(
    new CopyObjectCommand({
      Bucket: settings.bucket,
      Key: targetKey,
      CopySource: `${settings.bucket}/${sourceKey}`,
    })
  );
  return targetKey;
}

async function restoreAssetToLocal(projectUuid, storedName, localPath) {
  if (!remoteEnabled) return false;
  await ensureBucketReady();
  const s3 = createClient();
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: settings.bucket,
      Key: keyForAsset(projectUuid, storedName),
    })
  );
  ensureDir(path.dirname(localPath));
  await pipeline(response.Body, fs.createWriteStream(localPath));
  return true;
}

async function deleteProjectAssets(projectUuid) {
  if (!remoteEnabled) return;
  await ensureBucketReady();
  const s3 = createClient();
  const prefix = keyForAsset(projectUuid, '').replace(/\/$/, '');
  let continuationToken;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: settings.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const objects = (page.Contents || []).map((item) => ({ Key: item.Key }));
    if (objects.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: settings.bucket,
          Delete: { Objects: objects, Quiet: true },
        })
      );
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

module.exports = {
  isRemoteEnabled: remoteEnabled,
  settings,
  publicBaseUrl,
  keyForAsset,
  publicUrlForKey,
  publicUrlForAsset,
  ensureBucketReady,
  uploadLocalFile,
  uploadBuffer,
  createPresignedUpload,
  headKey,
  downloadKeyToLocal,
  deleteKey,
  copyAsset,
  restoreAssetToLocal,
  deleteProjectAssets,
};
