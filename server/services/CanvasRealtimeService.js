const subscribersByCanvas = new Map();
const recentChangesByCanvas = new Map();
let eventSequence = 0;

function subscribeCanvasChanges(canvasId, listener) {
  const key = String(canvasId);
  const subscribers = subscribersByCanvas.get(key) || new Set();
  subscribers.add(listener);
  subscribersByCanvas.set(key, subscribers);

  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) subscribersByCanvas.delete(key);
  };
}

function publishCanvasChange(change = {}) {
  const canvasId = String(change.canvasId || '');
  if (!canvasId) return null;

  eventSequence += 1;
  const event = {
    id: `${Date.now()}-${eventSequence}`,
    type: 'canvas_changed',
    canvasId,
    source: String(change.source || 'server'),
    reason: String(change.reason || 'canvas_update'),
    revision: String(change.revision || ''),
    contentVersion: String(change.contentVersion || change.revision || ''),
    clientId: String(change.clientId || ''),
    fullSnapshot: Boolean(change.fullSnapshot),
    pluginEditAtMs: Number(change.pluginEditAtMs || change.changedAtMs || Date.now()),
    changedAtMs: Number(change.changedAtMs || Date.now()),
    updatedBy: Number(change.updatedBy || 0) || null,
    changedNodeKeys: [...new Set(
      (Array.isArray(change.changedNodeKeys) ? change.changedNodeKeys : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )].slice(0, 500),
    deletedNodeKeys: [...new Set(
      (Array.isArray(change.deletedNodeKeys) ? change.deletedNodeKeys : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )].slice(0, 500),
    eventCursor: Number(change.eventCursor || 0) || null,
    nodeEvent: change.nodeEvent && typeof change.nodeEvent === 'object'
      ? change.nodeEvent
      : null,
    accessSessionEpoch: Number(change.accessSessionEpoch || 0) || null,
  };

  const subscribers = subscribersByCanvas.get(canvasId);
  const recentChanges = recentChangesByCanvas.get(canvasId) || [];
  recentChanges.push(event);
  recentChangesByCanvas.set(canvasId, recentChanges.slice(-50));
  if (!subscribers) return event;
  for (const listener of [...subscribers]) {
    try {
      listener(event);
    } catch (error) {
      console.warn('canvas realtime subscriber failed:', error.message);
    }
  }
  return event;
}

function canvasChangedNodeKeysSince(canvasId, pluginEditAtMs) {
  const requestedSince = Number(pluginEditAtMs || 0);
  const since = Number.isFinite(requestedSince) && requestedSince >= 0 ? requestedSince : 0;
  const keys = (recentChangesByCanvas.get(String(canvasId)) || [])
    .filter((event) => Number(event.pluginEditAtMs || 0) > since)
    .flatMap((event) => event.changedNodeKeys || []);
  return [...new Set(keys)].slice(0, 500);
}

function canvasSubscriberCount(canvasId) {
  return subscribersByCanvas.get(String(canvasId))?.size || 0;
}

function recentCanvasChangesSince(canvasId, eventId) {
  const events = recentChangesByCanvas.get(String(canvasId)) || [];
  if (!eventId) return events.slice();
  const index = events.findIndex((event) => event.id === String(eventId));
  return index < 0 ? [] : events.slice(index + 1);
}

module.exports = {
  canvasChangedNodeKeysSince,
  canvasSubscriberCount,
  publishCanvasChange,
  recentCanvasChangesSince,
  subscribeCanvasChanges,
};
