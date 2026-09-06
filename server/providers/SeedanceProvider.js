const videoRules = require('../videoRules');

module.exports = {
  getVideoGenerationCounts: videoRules.getVideoGenerationCounts,
  getVideoModeRule: videoRules.getVideoModeRule,
  getVideoModelRule: videoRules.getVideoModelRule,
  normalizeVideoCount: videoRules.normalizeVideoCount,
  normalizeVideoDuration: videoRules.normalizeVideoDuration,
  normalizeVideoMode: videoRules.normalizeVideoMode,
  normalizeVideoRatio: videoRules.normalizeVideoRatio,
  normalizeVideoResolution: videoRules.normalizeVideoResolution,
  rules: videoRules.rules,
  seedanceOmniReferenceTaskType: videoRules.seedanceOmniReferenceTaskType,
  seedanceOmniPrompt: videoRules.seedanceOmniPrompt,
  validateVideoCapabilities: videoRules.validateVideoCapabilities,
};
