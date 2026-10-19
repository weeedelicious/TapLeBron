import * as THREE from "three";
import { OrbitControls } from "/mstudio/vendor/jsm/controls/OrbitControls.js";
import { TransformControls } from "/mstudio/vendor/jsm/controls/TransformControls.js";
import { GLTFLoader } from "/mstudio/vendor/jsm/loaders/GLTFLoader.js";

const embedded = window.parent !== window;
const statusNode = document.querySelector("#status");
const leftPanel = document.querySelector("#left-panel");
const inspector = document.querySelector("#inspector");
const timeline = document.querySelector("#timeline");
const referenceImage = document.querySelector("#reference");
const viewCanvas = document.querySelector("#view");
const monitorCanvas = document.querySelector("#monitor-canvas");
const monitorFrame = document.querySelector("#monitor");

const LIBRARY = [
  ["mannequin", "人物白模"],
  ["box", "方块"],
  ["sphere", "球体"],
  ["cylinder", "圆柱"],
  ["plane", "平面"],
  ["arch", "拱门"],
  ["stairs", "楼梯"],
  ["door", "门框"],
  ["table", "桌子"],
  ["chair", "椅子"],
  ["tree", "树"],
  ["car", "车辆"],
  ["window", "窗"],
  ["sofa", "沙发"],
  ["roof", "屋顶"],
];

const JOINTS = [
  ["hips", null, [0, 0.98, 0], [0, 0, 0], 0.1, 0.12],
  ["spine", "hips", [0, 0.1, 0], [0, 0, 0], 0.18, 0.09],
  ["chest", "spine", [0, 0.18, 0], [0, 0, 0], 0.24, 0.105],
  ["neck", "chest", [0, 0.24, 0], [0, 0, 0], 0.08, 0.045],
  ["head", "neck", [0, 0.08, 0], [0, 0, 0], 0.2, 0.09],
  ["clavicleL", "chest", [-0.08, 0.18, 0], [0, 0, 8], 0.14, 0.04],
  ["shoulderL", "clavicleL", [0, 0.14, 0], [0, 0, 68], 0.26, 0.045],
  ["elbowL", "shoulderL", [0, 0.26, 0], [0, 0, 0], 0.24, 0.038],
  ["wristL", "elbowL", [0, 0.24, 0], [0, 0, 0], 0.06, 0.03],
  ["handL", "wristL", [0, 0.06, 0], [0, 0, 0], 0.08, 0.028],
  ["fingerL", "handL", [0, 0.08, 0], [0, 0, 0], 0.07, 0.018],
  ["clavicleR", "chest", [0.08, 0.18, 0], [0, 0, -8], 0.14, 0.04],
  ["shoulderR", "clavicleR", [0, 0.14, 0], [0, 0, -68], 0.26, 0.045],
  ["elbowR", "shoulderR", [0, 0.26, 0], [0, 0, 0], 0.24, 0.038],
  ["wristR", "elbowR", [0, 0.24, 0], [0, 0, 0], 0.06, 0.03],
  ["handR", "wristR", [0, 0.06, 0], [0, 0, 0], 0.08, 0.028],
  ["fingerR", "handR", [0, 0.08, 0], [0, 0, 0], 0.07, 0.018],
  ["hipL", "hips", [-0.1, 0.02, 0], [180, 0, 0], 0.42, 0.07],
  ["kneeL", "hipL", [0, 0.42, 0], [0, 0, 0], 0.4, 0.055],
  ["footL", "kneeL", [0, 0.4, 0], [-78, 0, 0], 0.12, 0.04],
  ["toeL", "footL", [0, 0.12, 0], [0, 0, 0], 0.08, 0.028],
  ["hipR", "hips", [0.1, 0.02, 0], [180, 0, 0], 0.42, 0.07],
  ["kneeR", "hipR", [0, 0.42, 0], [0, 0, 0], 0.4, 0.055],
  ["footR", "kneeR", [0, 0.4, 0], [-78, 0, 0], 0.12, 0.04],
  ["toeR", "footR", [0, 0.12, 0], [0, 0, 0], 0.08, 0.028],
];

const POSES = {
  stand: {},
  tpose: { shoulderL: [0, 0, 24], shoulderR: [0, 0, -24], clavicleL: [0, 0, 18], clavicleR: [0, 0, -18] },
  squat: { hipL: [-58, 0, 0], kneeL: [78, 0, 0], hipR: [-58, 0, 0], kneeR: [78, 0, 0], spine: [16, 0, 0] },
  deep: { hipL: [-78, 0, 0], kneeL: [110, 0, 0], hipR: [-78, 0, 0], kneeR: [110, 0, 0], spine: [28, 0, 0], shoulderL: [18, 0, 0], shoulderR: [18, 0, 0] },
  sit: { hipL: [-92, 0, 0], kneeL: [92, 0, 0], hipR: [-92, 0, 0], kneeR: [92, 0, 0], spine: [8, 0, 0] },
  reach: { shoulderL: [-16, 0, -36], elbowL: [0, 0, -48], shoulderR: [-16, 0, 36], elbowR: [0, 0, 48] },
  up: { shoulderL: [-70, 0, -10], elbowL: [0, 0, -16], shoulderR: [-70, 0, 10], elbowR: [0, 0, 16] },
  lean: { spine: [24, 0, 0], chest: [16, 0, 0], neck: [12, 0, 0], shoulderL: [10, 0, 8], shoulderR: [10, 0, -8] },
  nod: { neck: [22, 0, 0], head: [18, 0, 0] },
  lookL: { neck: [0, 28, 0], head: [0, 20, 0] },
  lookR: { neck: [0, -28, 0], head: [0, -20, 0] },
};

const CLIPS = {
  walk: [
    { hipL: [-34, 0, 0], kneeL: [18, 0, 0], footL: [8, 0, 0], hipR: [22, 0, 0], kneeR: [28, 0, 0], footR: [-8, 0, 0], shoulderL: [18, 0, 0], shoulderR: [-16, 0, 0], spine: [4, 8, 0] },
    { hipL: [-8, 0, 0], kneeL: [48, 0, 0], footL: [6, 0, 0], hipR: [-6, 0, 0], kneeR: [12, 0, 0], shoulderL: [4, 0, 0], shoulderR: [-4, 0, 0] },
    { hipL: [22, 0, 0], kneeL: [28, 0, 0], footL: [-8, 0, 0], hipR: [-34, 0, 0], kneeR: [18, 0, 0], footR: [8, 0, 0], shoulderL: [-16, 0, 0], shoulderR: [18, 0, 0], spine: [4, -8, 0] },
    { hipL: [-6, 0, 0], kneeL: [12, 0, 0], hipR: [-8, 0, 0], kneeR: [48, 0, 0], footR: [6, 0, 0], shoulderL: [-4, 0, 0], shoulderR: [4, 0, 0] },
  ],
  run: [
    { hipL: [-50, 0, 0], kneeL: [30, 0, 0], hipR: [28, 0, 0], kneeR: [55, 0, 0], shoulderL: [28, 0, 0], shoulderR: [-24, 0, 0], spine: [10, 0, 0], elbowL: [0, 0, -20], elbowR: [0, 0, 35] },
    { hipL: [-12, 0, 0], kneeL: [80, 0, 0], hipR: [-8, 0, 0], kneeR: [20, 0, 0], shoulderL: [6, 0, 0], shoulderR: [-6, 0, 0] },
    { hipL: [28, 0, 0], kneeL: [55, 0, 0], hipR: [-50, 0, 0], kneeR: [30, 0, 0], shoulderL: [-24, 0, 0], shoulderR: [28, 0, 0], spine: [10, 0, 0], elbowL: [0, 0, 35], elbowR: [0, 0, -20] },
    { hipL: [-8, 0, 0], kneeL: [20, 0, 0], hipR: [-12, 0, 0], kneeR: [80, 0, 0], shoulderL: [-6, 0, 0], shoulderR: [6, 0, 0] },
  ],
  wave: [
    { shoulderR: [-46, 0, 30], elbowR: [0, 0, 62], wristR: [0, 0, 12], spine: [0, -6, 0] },
    { shoulderR: [-58, 0, 18], elbowR: [0, 0, 18], wristR: [0, 0, -10], spine: [0, 4, 0] },
  ],
};

const PRESET_LIST = [
  ["stand", "站立"], ["tpose", "T型"], ["squat", "半蹲"], ["deep", "全蹲"], ["sit", "坐姿"],
  ["reach", "伸手"], ["up", "举手"], ["lean", "含胸"], ["nod", "点头"], ["lookL", "左转"], ["lookR", "右转"],
  ["walk", "行走"], ["run", "奔跑"], ["wave", "招手"],
];

const CHAINS = {
  handL: ["clavicleL", "shoulderL", "elbowL", "wristL", "handL"],
  handR: ["clavicleR", "shoulderR", "elbowR", "wristR", "handR"],
  footL: ["hipL", "kneeL", "footL"],
  footR: ["hipR", "kneeR", "footR"],
};

function ensureMotion(record) {
  if (!record.motion || typeof record.motion !== "object") {
    record.motion = { clip: "none", phase: 0, loop: false, footLock: false };
  }
  return record.motion;
}
function clipPose(keys, phase) {
  const wrapped = ((phase % 1) + 1) % 1;
  const scaled = wrapped * keys.length;
  const index = Math.floor(scaled) % keys.length;
  const next = (index + 1) % keys.length;
  let amount = scaled - Math.floor(scaled);
  amount = amount * amount * (3 - 2 * amount);
  return blendPose(keys[index], keys[next], amount);
}
function applyPreset(record, name) {
  const motion = ensureMotion(record);
  motion.loop = false;
  if (CLIPS[name]) {
    motion.clip = name;
    motion.phase = 0;
    record.pose = clipPose(CLIPS[name], 0);
    record.position[1] = 0;
    return;
  }
  motion.clip = "none";
  record.pose = clone(POSES[name] || {});
  if (name === "squat") record.position[1] = -0.18;
  else if (name === "deep") record.position[1] = -0.38;
  else if (name === "sit") record.position[1] = -0.42;
  else record.position[1] = 0;
}
function readPoseLibrary() {
  try { return JSON.parse(localStorage.getItem("mstudio-pose-library-v1") || "[]"); }
  catch (error) { return []; }
}
function writePoseLibrary(items) {
  localStorage.setItem("mstudio-pose-library-v1", JSON.stringify(items.slice(0, 40)));
}
function rememberFeet(record) {
  const entry = sceneNodes.get(record.id);
  const motion = ensureMotion(record);
  if (!entry) return;
  ["footL", "footR"].forEach((name) => {
    const tip = entry.tips[name];
    if (!tip) return;
    const point = new THREE.Vector3();
    tip.getWorldPosition(point);
    motion[name + "Y"] = round(point.y);
  });
}

let project = createProject();
let tab = "library";
let mode = "translate";
let shiftHeld = false;
let aimId = "";
let pickedKey = null;
let keyClipboard = null;
let selected = "camera";
let frame = 0;
let playing = false;
let lastTime = 0;
const past = [];
const future = [];
const sceneNodes = new Map();
const guide = new THREE.Group();
guide.name = "guides";
let suspendEval = false;
let signature = "";

const stage = new THREE.Scene();
const editor = new THREE.Scene();
editor.add(stage);
editor.add(guide);
stage.add(new THREE.HemisphereLight(0xf3ecff, 0x2a2418, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(4, 8, 3);
stage.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(18, 48), new THREE.MeshStandardMaterial({ color: 0x1a1722, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
ground.userData.ignore = true;
stage.add(ground);
const grid = new THREE.GridHelper(20, 20, 0x6d5b9a, 0x3a3150);
grid.userData.ignore = true;
grid.layers.set(1);
stage.add(grid);

const viewCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
viewCamera.layers.enable(1);
viewCamera.position.set(5.2, 3.2, 6.4);
const shotCamera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 200);
shotCamera.filmGauge = 36;
shotCamera.name = "shot-camera";
stage.add(shotCamera);

const editorRenderer = new THREE.WebGLRenderer({ canvas: viewCanvas, antialias: true, alpha: true });
editorRenderer.setClearColor(0x000000, 0);
editorRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
editorRenderer.outputColorSpace = THREE.SRGBColorSpace;
const monitorRenderer = new THREE.WebGLRenderer({ canvas: monitorCanvas, antialias: true });
monitorRenderer.setClearColor(0x09080e, 1);
monitorRenderer.outputColorSpace = THREE.SRGBColorSpace;
const exportRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
exportRenderer.setClearColor(0x000000, 0);
exportRenderer.outputColorSpace = THREE.SRGBColorSpace;

const orbit = new OrbitControls(viewCamera, viewCanvas);
orbit.target.set(0, 1, 0);
orbit.enableDamping = true;
orbit.mouseButtons.MIDDLE = orbit.mouseButtons.LEFT;
orbit.mouseButtons.LEFT = -1;
const transformer = new TransformControls(viewCamera, viewCanvas);
transformer.setSize(0.85);
editor.add(transformer.getHelper());
transformer.addEventListener("mouseDown", () => {
  orbit.enabled = false;
  remember();
  suspendEval = true;
});
transformer.addEventListener("objectChange", readTransformer);
transformer.addEventListener("mouseUp", () => {
  orbit.enabled = true;
  suspendEval = false;
  refreshPanels();
  scheduleSave();
});

const raycaster = new THREE.Raycaster();
raycaster.layers.enable(1);
const pointer = new THREE.Vector2();
let pressX = 0;
let pressY = 0;

function uid(prefix) {
  return prefix + Math.random().toString(36).slice(2, 8);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function radians(values) {
  return values.map((value) => value * Math.PI / 180);
}
function degreesFromEuler(euler) {
  return [euler.x, euler.y, euler.z].map((value) => value * 180 / Math.PI);
}
function round(value) {
  return Math.round(value * 100) / 100;
}
function setStatus(text) {
  statusNode.textContent = text;
}
function post(message) {
  if (!embedded) return;
  window.parent.postMessage(message, window.location.origin);
}

function createProject() {
  const shot = createShot("镜头 01");
  return { format: "mstudio-workbench", version: 1, activeShotId: shot.id, shots: [shot] };
}
function createShot(name) {
  return {
    id: uid("shot_"),
    name,
    fps: 24,
    duration: 15,
    loop: true,
    aspect: [16, 9],
    focal: 35,
    camera: { position: [3.1, 1.65, 4.4], rotation: [-8, 32, 0] },
    view: { position: [5.2, 3.2, 6.4], target: [0, 1, 0] },
    cameraKeys: [],
    objectKeys: {},
    reference: { url: "", opacity: 0.45, scale: 1, x: 50, y: 50, locked: false, includeInExport: false },
    objects: [createRecord("mannequin", "人物 01")],
  };
}
function createRecord(kind, name) {
  return {
    id: uid("obj_"),
    kind,
    name,
    color: kind === "mannequin" ? "#f6f1e8" : "#d8d0c4",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    visible: true,
    locked: false,
    pose: {},
    body: "standard",
    motion: { clip: "none", phase: 0, loop: false, footLock: false },
    sourceData: "",
  };
}
function shot() {
  return project.shots.find((item) => item.id === project.activeShotId) || project.shots[0];
}
function totalFrames() {
  return Math.max(1, Math.round(shot().duration * shot().fps));
}
function selectedRecord() {
  return shot().objects.find((item) => item.id === selected) || null;
}

function remember() {
  past.push(JSON.stringify(project));
  if (past.length > 40) past.shift();
  future.length = 0;
}
function undo() {
  if (!past.length) return;
  future.push(JSON.stringify(project));
  project = JSON.parse(past.pop());
  afterHistory();
}
function redo() {
  if (!future.length) return;
  past.push(JSON.stringify(project));
  project = JSON.parse(future.pop());
  afterHistory();
}
function afterHistory() {
  frame = Math.min(frame, totalFrames());
  rebuild();
  refreshPanels();
  scheduleSave();
}
function edit(mutator) {
  remember();
  mutator();
  syncAll();
  refreshPanels();
  scheduleSave();
}

function maxKey(current) {
  let max = 0;
  current.cameraKeys.forEach((key) => { max = Math.max(max, key.frame); });
  Object.values(current.objectKeys).forEach((list) => list.forEach((key) => { max = Math.max(max, key.frame); }));
  return max;
}

function addObject(kind) {
  if (kind === "gltf") return;
  edit(() => {
    const record = createRecord(kind, LIBRARY.find((item) => item[0] === kind)[1]);
    record.position = [shot().objects.length * 0.4, 0, 0];
    shot().objects.push(record);
    selected = record.id;
  });
}

function materialFor(record) {
  const material = new THREE.MeshStandardMaterial({ color: record.color, roughness: 0.72, metalness: 0.02 });
  return material;
}
function mesh(geometry, material) {
  const item = new THREE.Mesh(geometry, material);
  item.castShadow = true;
  item.receiveShadow = true;
  return item;
}
function buildProp(record, material) {
  const root = new THREE.Group();
  if (record.kind === "box") root.add(mesh(new THREE.BoxGeometry(1, 1, 1), material));
  if (record.kind === "sphere") root.add(mesh(new THREE.SphereGeometry(0.5, 24, 16), material));
  if (record.kind === "cylinder") root.add(mesh(new THREE.CylinderGeometry(0.45, 0.45, 1, 20), material));
  if (record.kind === "plane") {
    const item = mesh(new THREE.PlaneGeometry(2, 2), material);
    item.rotation.x = -Math.PI / 2;
    root.add(item);
  }
  if (record.kind === "arch") {
    root.add(placed(mesh(new THREE.BoxGeometry(0.28, 2.2, 0.28), material), -0.9, 1.1, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(0.28, 2.2, 0.28), material), 0.9, 1.1, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(2.1, 0.28, 0.28), material), 0, 2.25, 0));
  }
  if (record.kind === "stairs") {
    for (let step = 0; step < 6; step += 1) {
      root.add(placed(mesh(new THREE.BoxGeometry(1.4, 0.16, 0.42), material), 0, 0.08 + step * 0.16, -step * 0.42));
    }
  }
  if (record.kind === "door") {
    root.add(placed(mesh(new THREE.BoxGeometry(0.16, 2.1, 0.16), material), -0.55, 1.05, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(0.16, 2.1, 0.16), material), 0.55, 1.05, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(1.26, 0.16, 0.16), material), 0, 2.15, 0));
  }
  if (record.kind === "table") {
    root.add(placed(mesh(new THREE.BoxGeometry(1.5, 0.08, 0.8), material), 0, 0.75, 0));
    [[-0.65, -0.3], [0.65, -0.3], [-0.65, 0.3], [0.65, 0.3]].forEach((point) => {
      root.add(placed(mesh(new THREE.BoxGeometry(0.08, 0.75, 0.08), material), point[0], 0.37, point[1]));
    });
  }
  if (record.kind === "chair") {
    root.add(placed(mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), material), 0, 0.48, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), material), 0, 0.78, -0.22));
    [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].forEach((point) => {
      root.add(placed(mesh(new THREE.BoxGeometry(0.05, 0.48, 0.05), material), point[0], 0.24, point[1]));
    });
  }
  if (record.kind === "tree") {
    root.add(placed(mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.7, 8), material), 0, 0.35, 0));
    root.add(placed(mesh(new THREE.ConeGeometry(0.55, 1.3, 10), material), 0, 1.25, 0));
  }
  if (record.kind === "car") {
    root.add(placed(mesh(new THREE.BoxGeometry(1.8, 0.38, 0.8), material), 0, 0.38, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(0.9, 0.36, 0.72), material), -0.1, 0.72, 0));
    [[-0.55, -0.34], [0.55, -0.34], [-0.55, 0.34], [0.55, 0.34]].forEach((point) => {
      const wheel = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 12), material);
      wheel.rotation.z = Math.PI / 2;
      root.add(placed(wheel, point[0], 0.16, point[1]));
    });
  }
  if (record.kind === "window") {
    root.add(placed(mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), material), -0.7, 1.3, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), material), 0.7, 1.3, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(1.52, 0.12, 0.12), material), 0, 2.05, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(1.52, 0.12, 0.12), material), 0, 0.6, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), material), 0, 1.3, 0));
  }
  if (record.kind === "sofa") {
    root.add(placed(mesh(new THREE.BoxGeometry(1.6, 0.28, 0.62), material), 0, 0.4, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(1.6, 0.55, 0.16), material), 0, 0.75, -0.24));
    root.add(placed(mesh(new THREE.BoxGeometry(0.16, 0.4, 0.62), material), -0.78, 0.62, 0));
    root.add(placed(mesh(new THREE.BoxGeometry(0.16, 0.4, 0.62), material), 0.78, 0.62, 0));
  }
  if (record.kind === "roof") {
    const left = mesh(new THREE.BoxGeometry(1.35, 0.08, 1.2), material);
    left.rotation.z = 0.45;
    root.add(placed(left, -0.48, 1.15, 0));
    const right = mesh(new THREE.BoxGeometry(1.35, 0.08, 1.2), material);
    right.rotation.z = -0.45;
    root.add(placed(right, 0.48, 1.15, 0));
  }
  root.traverse((child) => { child.userData.ownerId = record.id; });
  return root;
}
function placed(item, x, y, z) {
  item.position.set(x, y, z);
  return item;
}
function buildMannequin(record, material) {
  const root = new THREE.Group();
  const joints = {};
  const tips = {};
  JOINTS.forEach((spec) => {
    const node = new THREE.Group();
    node.name = spec[0];
    const build = record.body === "broad" ? 1.16 : record.body === "slim" ? 0.86 : 1;
    const bulk = record.body === "broad" ? 1.18 : record.body === "slim" ? 0.84 : 1;
    node.position.set(spec[2][0] * build, spec[2][1], spec[2][2]);
    node.userData.base = spec[3];
    node.userData.length = spec[4];
    const radius = spec[5] * bulk;
    const limb = mesh(new THREE.CylinderGeometry(radius * 0.72, radius, Math.max(0.04, spec[4]), 10), material);
    limb.position.y = spec[4] / 2;
    const cap = mesh(new THREE.SphereGeometry(radius, 12, 8), material);
    cap.position.y = spec[4];
    node.add(limb, cap);
    const tip = new THREE.Object3D();
    tip.position.y = spec[4];
    node.add(tip);
    tips[spec[0]] = tip;
    joints[spec[0]] = node;
    const parent = spec[1] ? joints[spec[1]] : root;
    parent.add(node);
    const marker = mesh(new THREE.SphereGeometry(0.032, 10, 8), new THREE.MeshBasicMaterial({ color: 0xc4b5fd, depthTest: false }));
    marker.userData.pick = { type: "joint", objectId: record.id, joint: spec[0] };
    marker.renderOrder = 2;
    marker.layers.set(1);
    node.add(marker);
    guideAttach(marker);
  });
  Object.keys(CHAINS).forEach((endName) => {
    const target = mesh(new THREE.OctahedronGeometry(0.055), new THREE.MeshBasicMaterial({ color: 0xf5f3ff, depthTest: false }));
    target.userData.pick = { type: "ik", objectId: record.id, end: endName };
    target.renderOrder = 3;
    target.layers.set(1);
    guide.add(target);
    tips[endName + "Target"] = target;
  });
  root.traverse((child) => {
    if (!child.userData.pick) child.userData.ownerId = record.id;
  });
  return { root, joints, tips };
}
function guideAttach(marker) {
  marker.userData.keepLocal = true;
}

function rebuild() {
  sceneNodes.forEach((entry) => stage.remove(entry.root));
  sceneNodes.clear();
  while (guide.children.length) guide.remove(guide.children[0]);
  const current = shot();
  current.objects.forEach((record) => {
    const material = materialFor(record);
    let root;
    let joints = null;
    let tips = null;
    if (record.kind === "mannequin") {
      const built = buildMannequin(record, material);
      root = built.root;
      joints = built.joints;
      tips = built.tips;
    } else if (record.kind === "gltf" && record.sourceData) {
      root = new THREE.Group();
      root.add(mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), material));
      loadGltf(record, root, material);
    } else {
      root = buildProp(record, material);
    }
    stage.add(root);
    sceneNodes.set(record.id, { root, joints, tips, material });
  });
  signature = current.objects.map((record) => record.id + record.kind + (record.body || "")).join("|");
  applyCamera(current.camera, current.focal, current.aspect);
  syncAll();
  restoreView();
}
function loadGltf(record, root, material) {
  const bytes = dataUrlToBuffer(record.sourceData);
  const loader = new GLTFLoader();
  loader.parse(bytes, "", (gltf) => {
    root.clear();
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const tallest = Math.max(size.x, size.y, size.z, 0.001);
    model.scale.multiplyScalar(1.6 / tallest);
    const fitted = new THREE.Box3().setFromObject(model);
    model.position.y -= fitted.min.y;
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.userData.ownerId = record.id;
      }
    });
    root.add(model);
    root.traverse((child) => { child.userData.ownerId = record.id; });
  }, () => setStatus("模型读不出来"));
}
function dataUrlToBuffer(dataUrl) {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function applyRecord(record) {
  const entry = sceneNodes.get(record.id);
  if (!entry) return;
  entry.root.visible = record.visible;
  entry.root.position.set(record.position[0], record.position[1], record.position[2]);
  const rotation = radians(record.rotation);
  entry.root.rotation.set(rotation[0], rotation[1], rotation[2]);
  entry.root.scale.set(record.scale[0], record.scale[1], record.scale[2]);
  entry.material.color.set(record.color);
  if (entry.joints) {
    entry.joints.hips && JOINTS.forEach((spec) => {
      const node = entry.joints[spec[0]];
      const pose = record.pose[spec[0]] || [0, 0, 0];
      const base = node.userData.base;
      const next = radians([base[0] + pose[0], base[1] + pose[1], base[2] + pose[2]]);
      node.rotation.set(next[0], next[1], next[2]);
    });
    if (mode === "pose") placeTargets(entry);
  }
}
function placeTargets(entry) {
  Object.keys(CHAINS).forEach((endName) => {
    const tip = entry.tips[endName];
    const target = entry.tips[endName + "Target"];
    if (!tip || !target) return;
    tip.getWorldPosition(target.position);
  });
}
function applyCamera(camera, focal, aspect) {
  shotCamera.position.set(camera.position[0], camera.position[1], camera.position[2]);
  const rotation = radians(camera.rotation);
  shotCamera.rotation.set(rotation[0], rotation[1], rotation[2]);
  shotCamera.aspect = aspect[0] / aspect[1];
  shotCamera.setFocalLength(focal);
  shotCamera.updateProjectionMatrix();
  monitorFrame.style.aspectRatio = aspect[0] + " / " + aspect[1];
}
function restoreView() {
  const view = shot().view;
  viewCamera.position.set(view.position[0], view.position[1], view.position[2]);
  orbit.target.set(view.target[0], view.target[1], view.target[2]);
}
function storeView() {
  const view = shot().view;
  view.position = [round(viewCamera.position.x), round(viewCamera.position.y), round(viewCamera.position.z)];
  view.target = [round(orbit.target.x), round(orbit.target.y), round(orbit.target.z)];
}
function syncAll() {
  const current = shot();
  const nextSignature = current.objects.map((record) => record.id + record.kind + (record.body || "")).join("|");
  if (nextSignature !== signature) rebuild();
  if (suspendEval) return;
  evaluate(frame);
  guide.visible = mode === "pose";
  stage.traverse((child) => {
    if (child.userData.pick && child.userData.pick.type === "joint") child.visible = mode === "pose";
  });
  updateReference();
  attachSelection();
}
function updateReference() {
  const reference = shot().reference;
  referenceImage.src = reference.url || "";
  referenceImage.style.opacity = reference.url ? String(reference.opacity) : "0";
  referenceImage.style.left = reference.x + "%";
  referenceImage.style.top = reference.y + "%";
  referenceImage.style.width = (reference.scale * 70) + "%";
  referenceImage.style.height = (reference.scale * 70) + "%";
  referenceImage.style.transform = "translate(-50%, -50%)";
}

function blend(start, end, amount) {
  return start.map((value, index) => value + (end[index] - value) * amount);
}
function blendPose(start, end, amount) {
  const names = new Set([...Object.keys(start || {}), ...Object.keys(end || {})]);
  const pose = {};
  names.forEach((name) => {
    pose[name] = blend((start && start[name]) || [0, 0, 0], (end && end[name]) || [0, 0, 0], amount);
  });
  return pose;
}
function amountBetween(previous, next, value) {
  if (previous.interp === "hold") return 0;
  const span = Math.max(0.0001, next.frame - previous.frame);
  let amount = (value - previous.frame) / span;
  if (previous.interp === "smooth") amount = amount * amount * (3 - 2 * amount);
  return amount;
}
function sample(keys, value, fallback) {
  if (!keys || !keys.length) return fallback;
  const ordered = keys.slice().sort((a, b) => a.frame - b.frame);
  if (value <= ordered[0].frame) return ordered[0];
  const last = ordered[ordered.length - 1];
  if (value >= last.frame) return last;
  const nextIndex = ordered.findIndex((key) => key.frame >= value);
  const next = ordered[nextIndex];
  const previous = ordered[nextIndex - 1];
  if (next.frame === value) return next;
  const amount = amountBetween(previous, next, value);
  return {
    position: blend(previous.position, next.position, amount),
    rotation: blend(previous.rotation, next.rotation, amount),
    scale: blend(previous.scale || [1, 1, 1], next.scale || [1, 1, 1], amount),
    focal: (previous.focal || 35) + ((next.focal || 35) - (previous.focal || 35)) * amount,
    pose: blendPose(previous.pose, next.pose, amount),
  };
}
function evaluate(value) {
  const current = shot();
  const cameraSample = sample(current.cameraKeys, value, current.camera);
  applyCamera({
    position: cameraSample.position || current.camera.position,
    rotation: cameraSample.rotation || current.camera.rotation,
  }, cameraSample.focal || current.focal, current.aspect);
  current.objects.forEach((record) => {
    const sampled = sample(current.objectKeys[record.id], value, record);
    const entry = sceneNodes.get(record.id);
    if (!entry) return;
    const position = sampled.position || record.position;
    const rotation = sampled.rotation || record.rotation;
    const scale = sampled.scale || record.scale;
    entry.root.visible = record.visible;
    if (entry.material) entry.material.color.set(record.color);
    entry.root.position.set(position[0], position[1], position[2]);
    const rotationRadians = radians(rotation);
    entry.root.rotation.set(rotationRadians[0], rotationRadians[1], rotationRadians[2]);
    entry.root.scale.set(scale[0], scale[1], scale[2]);
    if (entry.joints && (sampled.pose || record.pose)) {
      const motion = record.motion || {};
      let activePose = sampled.pose || record.pose || {};
      if (motion.clip && motion.clip !== "none" && CLIPS[motion.clip]) {
        const phase = motion.loop ? ((value / Math.max(1, current.fps)) % 1) : (Number(motion.phase) || 0);
        activePose = clipPose(CLIPS[motion.clip], phase);
      }
      record.pose = activePose;
      JOINTS.forEach((spec) => {
        const node = entry.joints[spec[0]];
        if (!node) return;
        const pose = activePose[spec[0]] || [0, 0, 0];
        const base = node.userData.base;
        const next = radians([base[0] + pose[0], base[1] + pose[1], base[2] + pose[2]]);
        node.rotation.set(next[0], next[1], next[2]);
      });
    } else {
      applyRecord(record);
    }
    if (entry.joints && mode === "pose") placeTargets(entry);
  });
}

function currentFrame() {
  return Math.round(frame);
}
function upsertKey(list, sampleValue) {
  const frameNumber = currentFrame();
  let key = list.find((item) => item.frame === frameNumber);
  if (!key) {
    key = { id: uid("key_"), frame: frameNumber, interp: "linear" };
    list.push(key);
  }
  Object.assign(key, sampleValue, { frame: frameNumber });
  list.sort((a, b) => a.frame - b.frame);
  return key;
}
function captureObject(record, forceKey) {
  const list = shot().objectKeys[record.id] || [];
  const hasKeys = list.length > 0;
  if (forceKey || hasKeys) {
    if (!shot().objectKeys[record.id]) shot().objectKeys[record.id] = [];
    upsertKey(shot().objectKeys[record.id], {
      position: record.position.slice(),
      rotation: record.rotation.slice(),
      scale: record.scale.slice(),
      pose: clone(record.pose || {}),
    });
  }
}
function captureCamera(forceKey) {
  const current = shot();
  if (forceKey || current.cameraKeys.length) {
    upsertKey(current.cameraKeys, {
      position: current.camera.position.slice(),
      rotation: current.camera.rotation.slice(),
      focal: current.focal,
    });
  }
}
function readTransformer() {
  if (selected === "camera") {
    const current = shot();
    current.camera.position = [round(shotCamera.position.x), round(shotCamera.position.y), round(shotCamera.position.z)];
    current.camera.rotation = degreesFromEuler(shotCamera.rotation).map(round);
    captureCamera(false);
    return;
  }
  const record = selectedRecord();
  const entry = record && sceneNodes.get(record.id);
  if (!record || !entry) return;
  if (String(selectedPick.type) === "joint") {
    const node = entry.joints[selectedPick.joint];
    const raw = degreesFromEuler(node.rotation).map(round);
    const base = node.userData.base;
    const previous = record.pose[selectedPick.joint] || [0, 0, 0];
    const nextPose = shiftHeld
      ? [previous[0], round(raw[1] - base[1]), previous[2]]
      : [round(raw[0] - base[0]), round(raw[1] - base[1]), round(raw[2] - base[2])];
    record.pose[selectedPick.joint] = nextPose;
    if (shiftHeld) {
      const aimed = radians([base[0] + nextPose[0], base[1] + nextPose[1], base[2] + nextPose[2]]);
      node.rotation.set(aimed[0], aimed[1], aimed[2]);
    }
    if (record.motion) record.motion.clip = "none";
    captureObject(record, false);
    return;
  }
  if (selectedPick.type === "ik") {
    solveIk(entry, selectedPick.end);
    captureObject(record, false);
    return;
  }
  record.position = [round(entry.root.position.x), round(entry.root.position.y), round(entry.root.position.z)];
  record.rotation = degreesFromEuler(entry.root.rotation).map(round);
  record.scale = [round(entry.root.scale.x), round(entry.root.scale.y), round(entry.root.scale.z)];
  captureObject(record, false);
}
let selectedPick = { type: "object" };
function solveIk(entry, endName) {
  const names = CHAINS[endName];
  const target = entry.tips[endName + "Target"];
  const tip = entry.tips[endName];
  const goal = target.position.clone();
  const ownerNow = [...sceneNodes.entries()].find((pair) => pair[1] === entry);
  const ikRecord = ownerNow && shot().objects.find((item) => item.id === ownerNow[0]);
  if (ikRecord && ikRecord.motion && ikRecord.motion.footLock && String(endName).indexOf("foot") === 0) {
    const lockedY = ikRecord.motion[endName + "Y"];
    if (typeof lockedY === "number") goal.y = lockedY;
  }
  if (ikRecord && ikRecord.motion) ikRecord.motion.clip = "none";
  const end = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const toEnd = new THREE.Vector3();
  const toGoal = new THREE.Vector3();
  for (let iteration = 0; iteration < 8; iteration += 1) {
    for (let index = names.length - 1; index >= 0; index -= 1) {
      const bone = entry.joints[names[index]];
      tip.updateMatrixWorld(true);
      tip.getWorldPosition(end);
      bone.getWorldPosition(origin);
      toEnd.copy(end).sub(origin);
      toGoal.copy(goal).sub(origin);
      if (toEnd.lengthSq() < 1e-6 || toGoal.lengthSq() < 1e-6) continue;
      toEnd.normalize();
      toGoal.normalize();
      const delta = new THREE.Quaternion().setFromUnitVectors(toEnd, toGoal);
      const parentWorld = new THREE.Quaternion();
      bone.parent.getWorldQuaternion(parentWorld);
      bone.quaternion.copy(parentWorld.clone().invert().multiply(delta).multiply(parentWorld).multiply(bone.quaternion));
      bone.updateMatrixWorld(true);
    }
  }
  const record = shot().objects.find((item) => item.id === entry.root.userData || true);
  const owner = [...sceneNodes.entries()].find((pair) => pair[1] === entry);
  if (!owner) return;
  const data = shot().objects.find((item) => item.id === owner[0]);
  names.forEach((name) => {
    const node = entry.joints[name];
    const raw = degreesFromEuler(new THREE.Euler().setFromQuaternion(node.quaternion, "XYZ"));
    const base = node.userData.base;
    data.pose[name] = [round(raw[0] - base[0]), round(raw[1] - base[1]), round(raw[2] - base[2])];
  });
}

function attachSelection() {
  transformer.detach();
  selectedPick = { type: "object" };
  if (selected === "camera") {
    transformer.mode = mode === "rotate" ? "rotate" : "translate";
    if (mode === "scale" || mode === "pose" || mode === "reference") return;
    transformer.attach(shotCamera);
    return;
  }
  const record = selectedRecord();
  const entry = record && sceneNodes.get(record.id);
  if (!record || !entry || record.locked || !record.visible) return;
  if (mode === "pose") return;
  if (mode === "reference") return;
  transformer.mode = mode === "rotate" ? "rotate" : mode === "scale" ? "scale" : "translate";
  transformer.attach(entry.root);
}
function attachJoint(objectId, joint) {
  const entry = sceneNodes.get(objectId);
  if (!entry || !entry.joints[joint]) return;
  selected = objectId;
  selectedPick = { type: "joint", joint };
  transformer.mode = "rotate";
  transformer.attach(entry.joints[joint]);
  refreshPanels();
}
function attachIk(objectId, endName) {
  const entry = sceneNodes.get(objectId);
  const target = entry && entry.tips[endName + "Target"];
  if (!target) return;
  selected = objectId;
  selectedPick = { type: "ik", end: endName };
  transformer.mode = "translate";
  transformer.attach(target);
  refreshPanels();
}

viewCanvas.addEventListener("pointerdown", (event) => {
  pressX = event.clientX;
  pressY = event.clientY;
  if (mode === "reference" && shot().reference.url && !shot().reference.locked) {
    remember();
    const move = (next) => {
      const rect = viewCanvas.getBoundingClientRect();
      shot().reference.x = Math.round((next.clientX - rect.left) / rect.width * 100);
      shot().reference.y = Math.round((next.clientY - rect.top) / rect.height * 100);
      updateReference();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      scheduleSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
});
viewCanvas.addEventListener("pointerup", (event) => {
  if (Math.abs(event.clientX - pressX) > 5 || Math.abs(event.clientY - pressY) > 5) return;
  if (transformer.dragging) return;
  const rect = viewCanvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, viewCamera);
  const hits = raycaster.intersectObjects(stage.children, true).filter((hit) => !hit.object.userData.ignore && hit.object !== ground && hit.object !== grid && (hit.object.userData.pick || hit.object.userData.ownerId));
  if (!hits.length) return;
  let hit = hits[0];
  if (!event.altKey) {
    const same = hits.find((item) => (item.object.userData.ownerId || (item.object.userData.pick && item.object.userData.pick.objectId)) === selected);
    if (same) hit = same;
  }
  if (hit.object.userData.pick && mode === "pose") {
    const pick = hit.object.userData.pick;
    if (pick.type === "joint") attachJoint(pick.objectId, pick.joint);
    if (pick.type === "ik") attachIk(pick.objectId, pick.end);
    return;
  }
  if (hit.object.userData.ownerId) {
    selected = hit.object.userData.ownerId;
    aimId = selected;
    syncAll();
    refreshPanels();
  }
});

function resize() {
  const rect = viewCanvas.getBoundingClientRect();
  editorRenderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
  viewCamera.aspect = rect.width / Math.max(1, rect.height);
  viewCamera.updateProjectionMatrix();
  const monitorWidth = Math.max(1, monitorFrame.clientWidth);
  const aspect = shot().aspect[0] / shot().aspect[1];
  monitorRenderer.setSize(monitorWidth, monitorWidth / aspect, false);
}
new ResizeObserver(resize).observe(viewCanvas);
resize();

function animate(now) {
  requestAnimationFrame(animate);
  const delta = Math.min(0.05, (now - lastTime) / 1000 || 0);
  lastTime = now;
  if (playing) {
    frame += delta * shot().fps;
    if (frame > totalFrames()) {
      if (shot().loop) frame = 0;
      else { frame = totalFrames(); playing = false; }
    }
    evaluate(frame);
    const scrubber = document.querySelector("#scrubber");
    if (scrubber) scrubber.value = String(frame);
  }
  storeView();
  orbit.update();
  editorRenderer.render(editor, viewCamera);
  monitorRenderer.render(stage, shotCamera);
}
requestAnimationFrame(animate);

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}
function field(label, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.1";
  input.value = String(round(value));
  input.addEventListener("change", () => onChange(Number(input.value) || 0));
  wrap.append(input);
  return wrap;
}
function refreshPanels() {
  renderLeft();
  renderInspector();
  renderTimeline();
  updateReference();
  guide.visible = mode === "pose";
}
function renderLeft() {
  leftPanel.innerHTML = "";
  if (tab === "library") {
    const box = document.createElement("div");
    box.className = "library";
    LIBRARY.forEach((item) => box.append(button(item[1], "", () => addObject(item[0]))));
    const importButton = button("导入 GLB / GLTF", "", () => document.querySelector("#gltf").click());
    box.append(importButton);
    const input = document.createElement("input");
    input.id = "gltf";
    input.type = "file";
    input.accept = ".glb,.gltf,model/gltf-binary";
    input.hidden = true;
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 6 * 1024 * 1024) { setStatus("模型超过 6MB，请先压缩"); return; }
      const dataUrl = await file.arrayBuffer().then((buffer) => {
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
        return "data:model/gltf-binary;base64," + btoa(binary);
      });
      edit(() => {
        const record = createRecord("gltf", file.name.replace(/\.[^.]+$/, ""));
        record.sourceData = dataUrl;
        shot().objects.push(record);
        selected = record.id;
      });
    });
    box.append(input);
    leftPanel.append(box);
    return;
  }
  if (tab === "shots") {
    const box = document.createElement("div");
    box.className = "list";
    box.append(button("新建镜头", "mini", () => {
      if (project.shots.length >= 30) { setStatus("最多 30 个镜头"); return; }
      edit(() => {
        const copy = createShot("镜头 " + String(project.shots.length + 1).padStart(2, "0"));
        copy.objects = clone(shot().objects);
        copy.objects.forEach((record) => { record.id = uid("obj_"); });
        copy.camera = clone(shot().camera);
        copy.focal = shot().focal;
        copy.aspect = shot().aspect.slice();
        project.shots.push(copy);
        project.activeShotId = copy.id;
        selected = "camera";
        frame = 0;
      });
    }));
    box.append(button("复制镜头", "mini", () => {
      if (project.shots.length >= 30) return;
      edit(() => {
        const copy = clone(shot());
        copy.id = uid("shot_");
        copy.name += " 副本";
        project.shots.push(copy);
        project.activeShotId = copy.id;
      });
    }));
    box.append(button("更新缩略图", "mini", () => { captureThumb(); refreshPanels(); scheduleSave(); }));
    project.shots.forEach((item) => {
      const card = document.createElement("div");
      if (item.thumb) {
        const picture = document.createElement("img");
        picture.src = item.thumb;
        picture.alt = "";
        picture.style.width = "100%";
        picture.style.borderRadius = "8px";
        card.append(picture);
      }
      const row = button(item.name, "item" + (item.id === project.activeShotId ? " active" : ""), () => {
        captureThumb();
        storeView();
        project.activeShotId = item.id;
        frame = 0;
        rebuild();
        refreshPanels();
        scheduleSave();
      });
      card.append(row);
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = item.name;
      nameInput.addEventListener("change", () => edit(() => { item.name = nameInput.value || item.name; }));
      card.append(nameInput);
      if (project.shots.length > 1) {
        card.append(button("删除镜头", "mini", () => edit(() => {
          project.shots = project.shots.filter((shotItem) => shotItem.id !== item.id);
          if (project.activeShotId === item.id) project.activeShotId = project.shots[0].id;
          frame = 0;
        })));
      }
      box.append(card);
    });
    leftPanel.append(box);
    return;
  }
  const box = document.createElement("div");
  box.className = "list";
  const cameraButton = button("主摄像机", "item" + (selected === "camera" ? " active" : ""), () => {
    selected = "camera";
    syncAll();
    refreshPanels();
  });
  box.append(cameraButton);
  shot().objects.forEach((record) => {
    const row = document.createElement("div");
    row.className = "row";
    row.append(button(record.name, "item" + (record.id === selected ? " active" : ""), () => {
      selected = record.id;
      syncAll();
      refreshPanels();
    }));
    row.append(button(record.visible ? "显" : "隐", "mini", () => edit(() => { record.visible = !record.visible; })));
    row.append(button(record.locked ? "锁" : "开", "mini", () => edit(() => { record.locked = !record.locked; })));
    box.append(row);
  });
  leftPanel.append(box);
}
function vectorFields(label, values, onDone) {
  const wrap = document.createElement("div");
  ["X", "Y", "Z"].forEach((axis, index) => {
    wrap.append(field(label + " " + axis, values[index], (value) => onDone(index, value)));
  });
  return wrap;
}
function renderInspector() {
  inspector.innerHTML = "";
  const current = shot();
  const title = document.createElement("h2");
  title.textContent = selected === "camera" ? "摄像机" : (selectedRecord() ? selectedRecord().name : "属性");
  inspector.append(title);
  if (selected === "camera") {
    inspector.append(vectorFields("位置", current.camera.position, (index, value) => edit(() => {
      current.camera.position[index] = value;
      captureCamera(false);
    })));
    inspector.append(vectorFields("旋转", current.camera.rotation, (index, value) => edit(() => {
      current.camera.rotation[index] = value;
      captureCamera(false);
    })));
    inspector.append(field("焦距", current.focal, (value) => edit(() => {
      current.focal = Math.min(200, Math.max(8, value));
      captureCamera(false);
    })));
    const focalRow = document.createElement("div");
    focalRow.className = "row";
    [18, 24, 35, 50, 85, 120].forEach((focal) => focalRow.append(button(focal + "mm", "mini", () => edit(() => {
      current.focal = focal;
      captureCamera(false);
    }))));
    inspector.append(focalRow);
    const aspects = [[16, 9], [9, 16], [4, 3], [3, 4], [1, 1]];
    const row = document.createElement("div");
    row.className = "row";
    aspects.forEach((aspect) => row.append(button(aspect[0] + ":" + aspect[1], "mini", () => edit(() => { current.aspect = aspect.slice(); }))));
    inspector.append(row);
    const custom = document.createElement("div");
    custom.className = "row";
    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.value = String(current.aspect[0]);
    const heightInput = document.createElement("input");
    heightInput.type = "number";
    heightInput.value = String(current.aspect[1]);
    custom.append(widthInput, heightInput, button("自定义画幅", "mini", () => edit(() => {
      current.aspect = [Math.max(1, Number(widthInput.value) || 16), Math.max(1, Number(heightInput.value) || 9)];
    })));
    inspector.append(custom);
    inspector.append(button("摄像机对准", "mini", () => edit(() => aimCamera())));
    return;
  }
  const record = selectedRecord();
  if (!record) { inspector.textContent = "选择一个物体或摄像机。"; return; }
  const name = document.createElement("input");
  name.type = "text";
  name.value = record.name;
  name.addEventListener("change", () => edit(() => { record.name = name.value || record.name; }));
  inspector.append(name);
  const color = document.createElement("input");
  color.type = "color";
  color.value = record.color;
  color.addEventListener("input", () => { record.color = color.value; syncAll(); scheduleSave(); });
  inspector.append(color);
  inspector.append(vectorFields("位置", record.position, (index, value) => edit(() => {
    record.position[index] = value; captureObject(record, false);
  })));
  inspector.append(vectorFields("旋转", record.rotation, (index, value) => edit(() => {
    record.rotation[index] = value; captureObject(record, false);
  })));
  inspector.append(vectorFields("缩放", record.scale, (index, value) => edit(() => {
    record.scale[index] = Math.max(0.01, value); captureObject(record, false);
  })));
  const row = document.createElement("div");
  row.className = "row";
  row.append(button("复制", "mini", () => edit(() => {
    const copy = clone(record);
    copy.id = uid("obj_");
    copy.name += " 副本";
    copy.position = copy.position.slice();
    copy.position[0] += 0.4;
    shot().objects.push(copy);
    selected = copy.id;
  })));
  row.append(button("删除", "mini", () => edit(() => {
    shot().objects = shot().objects.filter((item) => item.id !== record.id);
    delete shot().objectKeys[record.id];
    selected = "camera";
  })));
  row.append(button("聚焦", "mini", () => focusRecord(record)));
  inspector.append(row);
  if (record.kind === "mannequin") {
    const poses = document.createElement("div");
    poses.className = "row";
    PRESET_LIST.forEach((item) => {
      poses.append(button(item[1], "mini", () => edit(() => {
        applyPreset(record, item[0]);
        captureObject(record, false);
      })));
    });
    inspector.append(poses);
    const bodies = document.createElement("div");
    bodies.className = "row";
    [["standard", "标准"], ["slim", "瘦"], ["broad", "宽"]].forEach((item) => {
      bodies.append(button(item[1], "mini", () => edit(() => { record.body = item[0]; })));
    });
    inspector.append(bodies);
    const motion = ensureMotion(record);
    inspector.append(field("相位", motion.phase || 0, (value) => edit(() => {
      motion.phase = Math.min(1, Math.max(0, value));
      if (motion.clip && CLIPS[motion.clip]) record.pose = clipPose(CLIPS[motion.clip], motion.phase);
      captureObject(record, false);
    })));
    const motionRow = document.createElement("div");
    motionRow.className = "row";
    motionRow.append(button(motion.loop ? "动作循环开" : "动作循环关", "mini", () => edit(() => { motion.loop = !motion.loop; })));
    motionRow.append(button(motion.footLock ? "脚底锁定" : "脚底不锁", "mini", () => edit(() => {
      motion.footLock = !motion.footLock;
      if (motion.footLock) rememberFeet(record);
    })));
    inspector.append(motionRow);
    inspector.append(button(mode === "pose" ? "退出摆姿" : "摆姿 / IK", "action", () => {
      mode = mode === "pose" ? "translate" : "pose";
      syncAll();
      refreshPanels();
    }));
    const poseTitle = document.createElement("h2");
    poseTitle.textContent = "本机姿势";
    inspector.append(poseTitle);
    const poseName = document.createElement("input");
    poseName.type = "text";
    poseName.placeholder = "姿势名称";
    inspector.append(poseName);
    inspector.append(button("保存当前姿势", "mini", () => {
      const items = readPoseLibrary();
      items.unshift({ id: uid("pose_"), name: poseName.value || "未命名姿势", pose: clone(record.pose || {}), body: record.body || "standard" });
      writePoseLibrary(items);
      refreshPanels();
      setStatus("姿势已存在这台浏览器");
    }));
    const saved = document.createElement("div");
    saved.className = "row";
    readPoseLibrary().forEach((item) => {
      saved.append(button(item.name, "mini", () => edit(() => {
        ensureMotion(record).clip = "none";
        record.pose = clone(item.pose || {});
        if (item.body) record.body = item.body;
        captureObject(record, false);
      })));
      saved.append(button("删", "mini", () => {
        writePoseLibrary(readPoseLibrary().filter((pose) => pose.id !== item.id));
        refreshPanels();
      }));
    });
    inspector.append(saved);
  }
  const reference = current.reference;
  const refTitle = document.createElement("h2");
  refTitle.textContent = "参考图";
  inspector.append(refTitle);
  inspector.append(button("上传参考图", "mini", () => document.querySelector("#ref-file").click()));
  const refInput = document.createElement("input");
  refInput.id = "ref-file";
  refInput.hidden = true;
  refInput.type = "file";
  refInput.accept = "image/png,image/jpeg,image/webp";
  refInput.addEventListener("change", async () => {
    const file = refInput.files && refInput.files[0];
    if (!file) return;
    const dataUrl = await compressImage(file);
    edit(() => { current.reference.url = dataUrl; });
  });
  inspector.append(refInput);
  inspector.append(field("透明", reference.opacity, (value) => edit(() => { current.reference.opacity = Math.min(1, Math.max(0, value)); })));
  inspector.append(field("大小", reference.scale, (value) => edit(() => { current.reference.scale = Math.max(0.2, value); })));
  const refRow = document.createElement("div");
  refRow.className = "row";
  refRow.append(button(reference.locked ? "解锁图" : "锁定图", "mini", () => edit(() => { current.reference.locked = !current.reference.locked; })));
  refRow.append(button("移动图", "mini", () => { mode = "reference"; setStatus("在画面上拖动参考图"); }));
  refRow.append(button(reference.includeInExport ? "导出含参考图" : "导出不含参考图", "mini", () => edit(() => { current.reference.includeInExport = !current.reference.includeInExport; })));
  inspector.append(refRow);
}
function focusRecord(record) {
  const entry = sceneNodes.get(record.id);
  if (!entry) return;
  const box = new THREE.Box3().setFromObject(entry.root);
  const center = box.getCenter(new THREE.Vector3());
  orbit.target.copy(center);
  viewCamera.position.copy(center).add(new THREE.Vector3(1.8, 1.2, 2.4));
}
function renderTimeline() {
  const current = shot();
  timeline.innerHTML = "";
  const top = document.createElement("div");
  top.className = "row";
  [["translate", "移动 W"], ["rotate", "旋转 E"], ["scale", "缩放 R"], ["pose", "摆姿 Q"]].forEach((item) => {
    const node = button(item[1], "mini" + (mode === item[0] ? " active" : ""), () => {
      mode = item[0];
      syncAll();
      refreshPanels();
    });
    if (mode === item[0]) node.style.background = "#7c3aed";
    top.append(node);
  });
  const play = button(playing ? "暂停" : "播放", "mini", () => { playing = !playing; renderTimeline(); });
  top.append(play);
  top.append(button("镜头关键帧", "mini", () => edit(() => captureCamera(true))));
  top.append(button("物体关键帧", "mini", () => {
    const record = selectedRecord();
    if (!record) { setStatus("先选中物体"); return; }
    edit(() => captureObject(record, true));
  }));
  timeline.append(top);
  const scrubber = document.createElement("input");
  scrubber.id = "scrubber";
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.max = String(totalFrames());
  scrubber.step = "1";
  scrubber.value = String(Math.round(frame));
  scrubber.addEventListener("input", () => {
    playing = false;
    frame = Number(scrubber.value);
    evaluate(frame);
  });
  timeline.append(scrubber);
  const settings = document.createElement("div");
  settings.className = "row";
  settings.append(field("帧率", current.fps, (value) => {
    const next = [24, 25, 30].includes(value) ? value : current.fps;
    const limit = maxKey(current);
    if (limit > current.duration * next) { setStatus("关键帧超出新的帧范围"); return; }
    edit(() => { current.fps = next; });
  }));
  settings.append(field("秒数", current.duration, (value) => {
    const next = Math.min(60, Math.max(1, value));
    if (maxKey(current) > next * current.fps) { setStatus("新时长装不下已有关键帧"); return; }
    edit(() => { current.duration = next; frame = Math.min(frame, totalFrames()); });
  }));
  settings.append(button(current.loop ? "循环开" : "循环关", "mini", () => edit(() => { current.loop = !current.loop; })));
  timeline.append(settings);
  const keyRow = document.createElement("div");
  keyRow.className = "row";
  keyRow.append(button("复制帧", "mini", () => {
    const found = findPicked();
    if (!found) { setStatus("先点中一个关键帧"); return; }
    keyClipboard = clone(found.key);
    setStatus("已复制第 " + found.key.frame + " 帧");
  }));
  keyRow.append(button("粘贴帧", "mini", () => {
    if (!keyClipboard || !pickedKey) { setStatus("还没有复制关键帧"); return; }
    edit(() => {
      const found = findPicked();
      if (!found) return;
      const frameNumber = currentFrame();
      const existing = found.list.find((item) => item.frame === frameNumber);
      const pasted = clone(keyClipboard);
      pasted.id = existing ? existing.id : uid("key_");
      pasted.frame = frameNumber;
      if (existing) Object.assign(existing, pasted);
      else found.list.push(pasted);
      found.list.sort((a, b) => a.frame - b.frame);
      pickedKey = { shotId: shot().id, track: pickedKey.track, keyId: pasted.id };
    });
  }));
  [["linear", "线性"], ["smooth", "平滑"], ["hold", "保持"]].forEach((item) => {
    keyRow.append(button(item[1], "mini", () => {
      const found = findPicked();
      if (!found) return;
      edit(() => { found.key.interp = item[0]; });
    }));
  });
  timeline.append(keyRow);
  timeline.append(track("摄像机", "camera", current.cameraKeys, (key) => edit(() => {
    current.cameraKeys = current.cameraKeys.filter((item) => item.id !== key.id);
  })));
  const record = selectedRecord();
  if (record) {
    timeline.append(track(record.name, record.id, current.objectKeys[record.id] || [], (key) => edit(() => {
      current.objectKeys[record.id] = (current.objectKeys[record.id] || []).filter((item) => item.id !== key.id);
    })));
  }
  const error = document.createElement("div");
  error.className = "error";
  error.id = "timeline-error";
  timeline.append(error);
}
function findPicked() {
  const current = shot();
  if (!pickedKey || pickedKey.shotId !== current.id) return null;
  const list = pickedKey.track === "camera" ? current.cameraKeys : (current.objectKeys[pickedKey.track] || []);
  const key = list.find((item) => item.id === pickedKey.keyId);
  return key ? { list, key } : null;
}
function track(label, trackId, keys, onDelete) {
  const wrap = document.createElement("div");
  const name = document.createElement("div");
  name.textContent = label;
  const bar = document.createElement("div");
  bar.className = "keys";
  keys.forEach((key) => {
    const mark = document.createElement("b");
    mark.style.left = (key.frame / Math.max(1, totalFrames()) * 100) + "%";
    mark.title = "拖动改帧，双击删除";
    if (pickedKey && pickedKey.keyId === key.id) mark.className = "selected";
    mark.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const originX = event.clientX;
      let dragged = false;
      const move = (next) => {
        if (Math.abs(next.clientX - originX) > 3) dragged = true;
        const rect = bar.getBoundingClientRect();
        key.frame = Math.round(Math.min(totalFrames(), Math.max(0, (next.clientX - rect.left) / Math.max(1, rect.width) * totalFrames())));
        mark.style.left = (key.frame / Math.max(1, totalFrames()) * 100) + "%";
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        keys.sort((a, b) => a.frame - b.frame);
        pickedKey = { shotId: shot().id, track: trackId, keyId: key.id };
        if (!dragged) {
          frame = key.frame;
          evaluate(frame);
        }
        scheduleSave();
        renderTimeline();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    mark.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDelete(key);
    });
    bar.append(mark);
  });
  wrap.append(name, bar);
  return wrap;
}
function aimCamera() {
  const current = shot();
  const record = current.objects.find((item) => item.id === aimId) || current.objects[0];
  const entry = record && sceneNodes.get(record.id);
  const target = new THREE.Vector3(0, 1, 0);
  if (entry) new THREE.Box3().setFromObject(entry.root).getCenter(target);
  shotCamera.lookAt(target);
  current.camera.position = [round(shotCamera.position.x), round(shotCamera.position.y), round(shotCamera.position.z)];
  current.camera.rotation = degreesFromEuler(shotCamera.rotation).map(round);
  captureCamera(false);
}
function captureThumb() {
  const current = shot();
  const width = 180;
  const height = Math.max(1, Math.round(width * current.aspect[1] / current.aspect[0]));
  const previous = guide.visible;
  guide.visible = false;
  exportRenderer.setSize(width, height, false);
  shotCamera.aspect = current.aspect[0] / current.aspect[1];
  shotCamera.updateProjectionMatrix();
  exportRenderer.render(stage, shotCamera);
  guide.visible = previous;
  current.thumb = exportRenderer.domElement.toDataURL("image/jpeg", 0.62);
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}
async function capturePng() {
  const current = shot();
  const width = 1280;
  const height = Math.max(1, Math.round(width * current.aspect[1] / current.aspect[0]));
  exportRenderer.setSize(width, height, false);
  const previous = guide.visible;
  guide.visible = false;
  shotCamera.aspect = current.aspect[0] / current.aspect[1];
  shotCamera.updateProjectionMatrix();
  exportRenderer.render(stage, shotCamera);
  guide.visible = previous;
  const board = document.createElement("canvas");
  board.width = width;
  board.height = height;
  const context = board.getContext("2d");
  context.fillStyle = "#121018";
  context.fillRect(0, 0, width, height);
  if (current.reference.url && current.reference.includeInExport) {
    await drawReference(context, current.reference, width, height);
  }
  context.drawImage(exportRenderer.domElement, 0, 0);
  const blob = await new Promise((resolve) => board.toBlob(resolve, "image/png"));
  if (embedded) {
    post({ type: "shotflow-previs:export", blob, kind: "png", width, height });
    setStatus("截图已送到画布");
  } else {
    downloadBlob(blob, current.name + ".png");
    setStatus("已下载截图");
  }
}
function drawReference(context, reference, width, height) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      context.save();
      context.globalAlpha = reference.opacity;
      const drawWidth = width * reference.scale;
      const drawHeight = drawWidth * (image.height / Math.max(1, image.width));
      context.drawImage(image, width * reference.x / 100 - drawWidth / 2, height * reference.y / 100 - drawHeight / 2, drawWidth, drawHeight);
      context.restore();
      resolve();
    };
    image.onerror = () => resolve();
    image.src = reference.url;
  });
}
function downloadBlob(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
function downloadProject() {
  const blob = new Blob([JSON.stringify(serialize())], { type: "application/json" });
  downloadBlob(blob, "mstudio-workbench.json");
}
function serialize() {
  storeView();
  return clone(project);
}
let saveTimer = 0;
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const payload = serialize();
    const text = JSON.stringify(payload);
    if (text.length > 9 * 1024 * 1024) {
      setStatus("工程太大，导入的模型可能无法保存");
    }
    if (embedded) {
      post({ type: "shotflow-previs:save", project: payload });
      setStatus("已保存");
    } else {
      localStorage.setItem("mstudio-workbench-v1", text);
      setStatus("已存到本机");
    }
  }, 400);
}

document.querySelectorAll(".tabs button").forEach((node) => {
  node.addEventListener("click", () => {
    tab = node.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((buttonNode) => buttonNode.classList.toggle("active", buttonNode === node));
    renderLeft();
  });
});
document.querySelector("#undo").addEventListener("click", undo);
document.querySelector("#redo").addEventListener("click", redo);
document.querySelector("#save-project").addEventListener("click", () => { scheduleSave(); downloadProject(); });
document.querySelector("#open-project").addEventListener("click", () => document.querySelector("#file").click());
document.querySelector("#file").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const parsed = JSON.parse(await file.text());
  if (!parsed || parsed.format !== "mstudio-workbench") { setStatus("这不是 M-studio 工程"); return; }
  project = parsed;
  frame = 0;
  rebuild();
  refreshPanels();
  scheduleSave();
});
document.querySelector("#shot-png").addEventListener("click", () => capturePng());
document.querySelector("#make-video").addEventListener("click", () => {
  if (!embedded) { setStatus("从画布里的 M-studio 节点打开后才能生成视频节点"); return; }
  post({ type: "shotflow-previs:create-video" });
  setStatus("已请求生成视频节点");
});
window.addEventListener("keyup", (event) => { if (event.key === "Shift") shiftHeld = false; });
window.addEventListener("keydown", (event) => {
  if (event.key === "Shift") { shiftHeld = true; return; }
  const typing = ["INPUT", "TEXTAREA"].includes(event.target.tagName);
  if (event.ctrlKey && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); return; }
  if (event.ctrlKey && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
  if (typing) return;
  if (event.key.toLowerCase() === "w") mode = "translate";
  if (event.key.toLowerCase() === "e") mode = "rotate";
  if (event.key.toLowerCase() === "r") mode = "scale";
  if (event.key.toLowerCase() === "q") mode = "pose";
  if (event.key.toLowerCase() === "f") { const record = selectedRecord(); if (record) focusRecord(record); }
  if (event.key === " ") { event.preventDefault(); playing = !playing; }
  if (event.key === "Delete" || event.key === "Backspace") {
    const record = selectedRecord();
    if (record) edit(() => {
      shot().objects = shot().objects.filter((item) => item.id !== record.id);
      selected = "camera";
    });
  }
  syncAll();
  refreshPanels();
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || !event.data) return;
  if (event.data.type === "shotflow-previs:load") {
    const incoming = event.data.project;
    if (incoming && incoming.format === "mstudio-workbench" && incoming.version === 1) project = incoming;
    else if (!incoming) project = createProject();
    if (event.data.reference && event.data.reference.url) {
      shot().reference.url = event.data.reference.url;
      shot().reference.locked = true;
    }
    frame = 0;
    rebuild();
    refreshPanels();
    gotLoad = true;
    window.clearInterval(readyTimer);
    post({ type: "shotflow-previs:loaded" });
    scheduleSave();
  }
  if (event.data.type === "shotflow-previs:reference") {
    const reference = event.data.reference;
    shot().reference.url = reference && reference.url ? reference.url : shot().reference.url;
    updateReference();
    scheduleSave();
  }
});

if (!embedded) {
  const saved = localStorage.getItem("mstudio-workbench-v1");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.format === "mstudio-workbench") project = parsed;
    } catch (error) { /* keep the default scene */ }
  }
}
rebuild();
refreshPanels();
let gotLoad = false;
let readyTimer = 0;
function announce() {
  if (!embedded || gotLoad) return;
  post({ type: "shotflow-previs:ready" });
}
announce();
readyTimer = window.setInterval(announce, 400);
setStatus(embedded ? "已连接画布" : "独立预览");
