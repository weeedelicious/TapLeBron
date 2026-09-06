const usageStore = require('../usageStore');

module.exports = {
  createPaidUsageLog: usageStore.createPaidUsageLog,
  createVideoTaskDetail: usageStore.createVideoTaskDetail,
  listPaidUsage: usageStore.listPaidUsage,
  updatePaidUsageLog: usageStore.updatePaidUsageLog,
  updateVideoTaskDetail: usageStore.updateVideoTaskDetail,
};
