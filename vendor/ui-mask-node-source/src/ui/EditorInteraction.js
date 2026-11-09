/** One pointer gesture at a time; a modal owns all editor input until it closes. */
let gesture = null;
const modals = [];

export function graphInputBlocked(event) {
  return modals.length > 0 || !!event?.defaultPrevented
    || !!event?.target?.closest?.('dialog[open], [data-editor-modal]');
}

export function isTextInput(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

export function cancelEditorGesture(reason = 'cancel') {
  gesture?.cancel(reason);
}

export function hasEditorGesture() { return gesture !== null; }

export function enterEditorModal(element) {
  cancelEditorGesture('modal-open');
  modals.push(element);
  element.dataset.editorModal = '';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    cancelEditorGesture('modal-close');
    const index = modals.lastIndexOf(element);
    if (index >= 0) modals.splice(index, 1);
    delete element.dataset.editorModal;
  };
}

/** Listeners live only as long as the current gesture, never once per rendered node. */
export function startEditorGesture(event, { element = event.currentTarget, scope = null, move, end, cancel }) {
  if (event.pointerId === undefined || !event.isPrimary) return false;
  if (modals.length && modals[modals.length - 1] !== scope) return false;
  if (![0, 1, 2].includes(event.button)) return false;
  cancelEditorGesture('superseded');
  const controller = new AbortController();
  const pointerId = event.pointerId;
  const button = event.button;
  const buttonMask = [1, 4, 2][button];
  let active = true;
  const finish = (reason, finalEvent) => {
    if (!active) return;
    active = false;
    controller.abort();
    gesture = null;
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    if (reason === 'up') end?.(finalEvent);
    else cancel?.(reason);
  };
  gesture = { cancel: reason => finish(reason) };
  const options = { signal: controller.signal, capture: true };
  document.addEventListener('pointermove', e => {
    if (e.pointerId !== pointerId) return;
    if (!(e.buttons & buttonMask)) { finish('buttons-released'); return; }
    if (!element.isConnected) { finish('detached'); return; }
    move?.(e);
  }, options);
  document.addEventListener('pointerup', e => {
    if (e.pointerId === pointerId && e.button === button) finish('up', e);
  }, options);
  document.addEventListener('pointercancel', e => {
    if (e.pointerId === pointerId) finish('pointercancel');
  }, options);
  element.addEventListener('lostpointercapture', () => finish('lost-capture'), options);
  try { element.setPointerCapture(pointerId); } catch { /* Document handlers still finish a mouse gesture. */ }
  event.preventDefault();
  return true;
}

window.addEventListener('blur', () => cancelEditorGesture('blur'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelEditorGesture('hidden');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !gesture) return;
  cancelEditorGesture('escape');
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
