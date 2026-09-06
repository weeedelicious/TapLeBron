const canvasMutationQueues = new Map();

function queueCanvasMutation(canvasId, operation) {
  const key = String(canvasId);
  const previous = canvasMutationQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  canvasMutationQueues.set(key, next);
  return next.finally(() => {
    if (canvasMutationQueues.get(key) === next) canvasMutationQueues.delete(key);
  });
}

module.exports = {
  queueCanvasMutation,
};
