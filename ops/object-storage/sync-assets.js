#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const config = require('../../server/config');
const objectStore = require('../../server/objectStore');

function mimeTypeFromName(name) {
  switch (path.extname(String(name || '')).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.avi':
      return 'video/x-msvideo';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.aac':
      return 'audio/aac';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}

async function main() {
  if (!objectStore.isRemoteEnabled) {
    throw new Error('Object storage is not enabled in .env');
  }

  await objectStore.ensureBucketReady();

  const projectEntries = fs
    .readdirSync(config.projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_tmp');

  let uploaded = 0;
  for (const projectEntry of projectEntries) {
    const projectUuid = projectEntry.name;
    const assetDir = path.join(config.projectsDir, projectUuid, 'assets');
    if (!fs.existsSync(assetDir)) continue;

    const assetEntries = fs.readdirSync(assetDir, { withFileTypes: true }).filter((entry) => entry.isFile());
    for (const assetEntry of assetEntries) {
      const storedName = assetEntry.name;
      const fullPath = path.join(assetDir, storedName);
      await objectStore.uploadLocalFile(projectUuid, storedName, fullPath, mimeTypeFromName(storedName));
      uploaded += 1;
      if (uploaded % 50 === 0) {
        console.log(`Uploaded ${uploaded} assets...`);
      }
    }
  }

  console.log(`Asset sync complete. Uploaded ${uploaded} asset files to object storage.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
