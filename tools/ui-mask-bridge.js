import { UiMaskSkill } from "/ui-mask-source/src/skills/UiMaskSkill.js";

function stableStamp(url) {
  let hash = 2166136261;
  const value = String(url || "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

const storageKey = (detail) => "shotflow-ui-mask:" + [detail.projectUuid || "", detail.nodeId || "", detail.url || ""].join("|");
const savedState = (detail) => {
  try { return JSON.parse(localStorage.getItem(storageKey(detail)) || "null"); }
  catch { return null; }
};

let host = null;
let node = null;
let current = null;

function remember() {
  if (!node || !current) return;
  const params = Object.fromEntries(Object.entries(node.params).map(([key, value]) => [key, value.value]));
  localStorage.setItem(storageKey(current), JSON.stringify({ params, maskTask: node.maskTask, results: node.results }));
}

window.editor = window.editor || {
  connections: [],
  _scheduleSave: remember,
  onNodeChange() {},
  resetDownstream() {},
  updateConnections() {},
};

function requestGenerate() {
  if (!node) return;
  if (node.busy) { node.show("正在处理，请稍候"); return; }
  if (!node.document) { node.show("请先手画遮罩，或先点辅助识别"); return; }
  const category = node.getParam("outputCategory");
  const ready = node.document.tracks.some((track) => track.kind === category && track.enabled && track.ranges.length);
  if (!ready) {
    node.show(category === "static" ? "还没有静态遮罩，请先手画或辅助识别" : "还没有动态遮罩，请先手画或切换输出类别");
    return;
  }
  node.generate();
}

function closeHost() {
  const closing = node;
  node = null;
  if (closing) Promise.resolve(closing.flushDocument && closing.flushDocument()).catch(() => {}).finally(() => closing.dispose && closing.dispose());
  if (host) host.remove();
  host = null;
  current = null;
}

function mountSkill(file, detail) {
  const saved = savedState(detail);
  if (node) node.dispose();
  node = new UiMaskSkill("shotflow-ui-mask", 0, 0);
  node.inputs[0].connectedFrom = {
    node: { getOutput: () => ({ sourceFile: file, fpsConvertMode: "none" }) },
    portName: "video",
  };
  if (saved) {
    for (const [key, value] of Object.entries(saved.params || {})) {
      if (node.params[key]) node.params[key].value = value;
    }
    node.maskTask = saved.maskTask;
    node.results = saved.results || [];
  }
  const element = document.createElement("div");
  host.querySelector(".sheet-body").replaceChildren(element);
  node.element = element;
  for (const [key, param] of Object.entries(node.params)) {
    const row = document.createElement("div");
    row.className = "node-param";
    const label = document.createElement("label");
    label.textContent = param.label;
    const select = document.createElement("select");
    select.dataset.key = key;
    for (const option of param.options) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    select.value = param.value;
    select.onchange = () => node.setParam(key, select.value);
    row.append(label, select);
    element.append(row);
  }
  const preview = document.createElement("div");
  preview.className = "preview-wrap";
  element.append(preview);
  node.onRendered();
  const generate = element.querySelector("[data-mask=generate]");
  if (generate) generate.textContent = "生成遮罩视频";
}

async function open(detail) {
  if (!detail || !detail.url) return;
  closeHost();
  current = detail;
  host = document.createElement("div");
  host.className = "shotflow-ui-mask-host";
  host.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="UI遮罩"><header><strong>UI 遮罩</strong><span class="source"></span><button type="button" data-close>关闭</button></header><div class="sheet-body"><p class="status">正在读取视频…</p></div><footer class="sheet-actions"><button type="button" data-generate>生成遮罩视频</button></footer></div>';
  host.querySelector("[data-close]").onclick = closeHost;
  host.querySelector("[data-generate]").onclick = requestGenerate;
  host.addEventListener("pointerdown", (event) => { if (event.target === host) closeHost(); });
  document.body.append(host);
  host.querySelector(".source").textContent = detail.name || "当前视频";
  try {
    const response = await fetch(detail.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error("读取视频失败（" + response.status + "）");
    const blob = await response.blob();
    const filename = "mask-source.mp4";
    const file = new File([blob], filename, { type: blob.type || "video/mp4", lastModified: stableStamp(detail.url) });
    mountSkill(file, detail);
    const health = await fetch("/api/ui-mask/health", { credentials: "same-origin" }).then((item) => item.json()).catch(() => null);
    const option = host && host.querySelector('[data-key="detector"] option[value="auto"]');
    if (option && health && !health.trainedAvailable) option.textContent = "AI 辅助（未安装，自动改用基础识别）";
  } catch (error) {
    const status = host && host.querySelector(".status");
    if (status) status.textContent = error.message || "遮罩工具打开失败";
  }
}


function mountEmbedded(container, detail) {
  let embedded = null;
  let cancelled = false;
  container.classList.add("shotflow-ui-mask-embedded");
  container.innerHTML = '<div class="sheet-body"><p class="status">正在读取视频…</p></div><footer class="sheet-actions"><button type="button" data-generate>生成遮罩视频</button></footer>';
  const generate = container.querySelector("[data-generate]");
  generate.onclick = () => {
    if (!embedded) return;
    const previous = node;
    node = embedded;
    try { requestGenerate(); }
    finally { node = previous; }
  };
  const run = async () => {
    const response = await fetch(detail.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error("读取视频失败（" + response.status + "）");
    const blob = await response.blob();
    const file = new File([blob], "mask-source.mp4", { type: blob.type || "video/mp4", lastModified: stableStamp(detail.url) });
    if (cancelled) return;
    const saved = savedState(detail);
    embedded = new UiMaskSkill("shotflow-ui-mask-" + (detail.nodeId || "node"), 0, 0);
    embedded.inputs[0].connectedFrom = {
      node: { getOutput: () => ({ sourceFile: file, fpsConvertMode: "none" }) },
      portName: "video",
    };
    if (saved) {
      for (const [key, value] of Object.entries(saved.params || {})) {
        if (embedded.params[key]) embedded.params[key].value = value;
      }
      embedded.maskTask = saved.maskTask;
      embedded.results = saved.results || [];
    }
    const element = document.createElement("div");
    container.querySelector(".sheet-body").replaceChildren(element);
    embedded.element = element;
    for (const [key, param] of Object.entries(embedded.params)) {
      const row = document.createElement("div");
      row.className = "node-param";
      const label = document.createElement("label");
      label.textContent = param.label;
      const select = document.createElement("select");
      select.dataset.key = key;
      for (const option of param.options) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        select.append(item);
      }
      select.value = param.value;
      select.onchange = () => embedded.setParam(key, select.value);
      row.append(label, select);
      element.append(row);
    }
    const preview = document.createElement("div");
    preview.className = "preview-wrap";
    element.append(preview);
    embedded.onRendered();
    const inner = element.querySelector("[data-mask=generate]");
    if (inner) inner.textContent = "生成遮罩视频";
  };
  run().catch((error) => {
    const status = container.querySelector(".status");
    if (status) status.textContent = error.message || "遮罩工具打开失败";
  });
  return () => {
    cancelled = true;
    if (embedded) {
      Promise.resolve(embedded.flushDocument && embedded.flushDocument()).catch(() => {}).finally(() => embedded.dispose && embedded.dispose());
      embedded = null;
    }
  };
}

window.ShotflowUiMask = { open, close: closeHost, mount: mountEmbedded };

window.addEventListener("keydown", (event) => {
  const editorOpen = document.querySelector(".ui-mask-editor[open], [data-editor-modal]");
  if (!host && !editorOpen) return;
  if (event.key === "Escape" && host && !editorOpen) {
    closeHost();
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && !event.target.closest(".ui-mask-editor, input, textarea, select, [contenteditable=true]")) event.stopPropagation();
}, true);

const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "/ui-mask-source/src/ui/ui-mask.css?v=20261021-ui-mask";
document.head.append(link);
const style = document.createElement("style");
style.textContent = ".shotflow-ui-mask-host{position:fixed;inset:0;z-index:300000;background:rgba(6,10,16,.72);display:flex;align-items:center;justify-content:center;padding:24px}.shotflow-ui-mask-host .sheet{width:min(860px,100%);max-height:min(920px,100%);overflow:hidden;display:flex;flex-direction:column;background:#172331;color:#dce5ee;border:1px solid #344b62;border-radius:14px;padding:18px 20px 16px;box-shadow:0 18px 60px rgba(0,0,0,.45)}.shotflow-ui-mask-host .sheet-body{overflow:auto;min-height:0}.shotflow-ui-mask-host .sheet-actions{display:flex;justify-content:flex-end;padding-top:12px}.shotflow-ui-mask-host .sheet-actions button{background:#24766e;border:1px solid #49b6a5;border-radius:6px;color:#e7f1fb;padding:8px 16px;font-weight:600;cursor:pointer}.shotflow-ui-mask-host header{display:flex;align-items:center;gap:12px;margin-bottom:8px}.shotflow-ui-mask-host header strong{font-size:18px}.shotflow-ui-mask-host header .source{color:#9eb1c4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shotflow-ui-mask-host header button{margin-left:auto;background:#243446;border:1px solid #486176;border-radius:6px;color:#e7f1fb;padding:6px 12px;cursor:pointer}.shotflow-ui-mask-host .ui-mask-card .ui-mask-primary{display:none}.shotflow-ui-mask-host .node-param{display:flex;gap:16px;align-items:center;margin:8px 0}.shotflow-ui-mask-host .node-param label{min-width:88px}.shotflow-ui-mask-host .node-param select{background:#14202c;border:1px solid #425b70;color:#e6f1fa;padding:7px;border-radius:4px;min-width:220px}.shotflow-ui-mask-host .preview-wrap{height:280px;margin:14px 0;background:#000;border-radius:8px;overflow:hidden}.shotflow-ui-mask-host .status{color:#aab9c9}";
document.head.append(style);
