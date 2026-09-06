const objectStore = require('../objectStore');

module.exports = {
  objectStore,
  isRemoteEnabled: objectStore.isRemoteEnabled,
  ensureBucketReady: objectStore.ensureBucketReady,
  uploadLocalFile: objectStore.uploadLocalFile,
  uploadBuffer: objectStore.uploadBuffer,
  copyProjectAsset: objectStore.copyProjectAsset,
  restoreAssetToLocal: objectStore.restoreAssetToLocal,
  deleteProjectAssets: objectStore.deleteProjectAssets,
  publicUrlForStoredName: objectStore.publicUrlForStoredName,
};
