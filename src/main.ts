import * as THREE from 'three';
import { MeshLineGeometry, MeshLineMaterial } from 'meshline';

const COLORS = ['#ff2a6d', '#05d9e8', '#d1f7ff', '#ffd300', '#39ff14', '#b967ff', '#ffffff', '#000000'];
const SPHERE_RADIUS = 8;
const MIN_MOVE_WORLD = 0.01;

type Tool = {
  id: string;
  label: string;
  width: number;
  dwellMs: number;
  dripChance: number;
  dripMaxLen: number;
  haloMult: number;
  haloOpacity: number;
  spatterChance: number;
  spatterCount: number;
};

const TOOLS: Tool[] = [
  {
    id: 'marker',
    label: 'Marcador',
    width: 0.025,
    dwellMs: 9999,
    dripChance: 0,
    dripMaxLen: 0,
    haloMult: 0,
    haloOpacity: 0,
    spatterChance: 0,
    spatterCount: 0,
  },
  {
    id: 'spray',
    label: 'Spray',
    width: 0.06,
    dwellMs: 120,
    dripChance: 0.18,
    dripMaxLen: 0.55,
    haloMult: 1.7,
    haloOpacity: 0.28,
    spatterChance: 0.25,
    spatterCount: 2,
  },
  {
    id: 'fatcap',
    label: 'Cap gordo',
    width: 0.12,
    dwellMs: 80,
    dripChance: 0.35,
    dripMaxLen: 0.9,
    haloMult: 2.3,
    haloOpacity: 0.38,
    spatterChance: 0.45,
    spatterCount: 4,
  },
];

const videoEl = document.getElementById('video') as HTMLVideoElement;
const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
const startEl = document.getElementById('start') as HTMLDivElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const toolsEl = document.getElementById('tools') as HTMLDivElement;
const colorsEl = document.getElementById('colors') as HTMLDivElement;
const sizeEl = document.getElementById('size') as HTMLDivElement;
const actionsEl = document.getElementById('actions') as HTMLDivElement;
const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement;
const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const errEl = document.getElementById('err') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl,
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);

const drawSphere = new THREE.Mesh(
  new THREE.SphereGeometry(SPHERE_RADIUS, 32, 24),
  new THREE.MeshBasicMaterial({ visible: false, side: THREE.BackSide }),
);
scene.add(drawSphere);

const strokesGroup = new THREE.Group();
scene.add(strokesGroup);

const raycaster = new THREE.Raycaster();
const strokes: Stroke[] = [];
const liveMaterials: MeshLineMaterial[] = [];

let currentColor = COLORS[0];
let currentTool: Tool = TOOLS[1];
let currentWidth = currentTool.width;
let orientationEnabled = false;
const deviceQuat = new THREE.Quaternion();
const resolution = new THREE.Vector2();

type StrokePart = 'main' | 'drip';
type HaloOpts = { widthMult: number; opacity: number };

const SPATTER_GEOMETRY = new THREE.SphereGeometry(1, 8, 6);

class Stroke {
  points: THREE.Vector3[] = [];
  private geometry: MeshLineGeometry;
  private material: MeshLineMaterial;
  private mesh: THREE.Mesh;
  private haloGeometry?: MeshLineGeometry;
  private haloMaterial?: MeshLineMaterial;
  private haloMesh?: THREE.Mesh;
  private spatter: THREE.Mesh[] = [];
  private lastPoint = new THREE.Vector3();
  private hasPoint = false;
  private widthFn?: (p: number) => number;
  part: StrokePart;

  constructor(
    color: string,
    width: number,
    part: StrokePart = 'main',
    widthFn?: (p: number) => number,
    halo?: HaloOpts,
  ) {
    this.part = part;
    this.widthFn = widthFn;

    this.geometry = new MeshLineGeometry();
    this.material = new MeshLineMaterial({
      color: new THREE.Color(color),
      lineWidth: width,
      resolution: resolution.clone(),
      sizeAttenuation: 1,
    });
    this.material.transparent = false;
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = part === 'drip' ? 3 : 2;
    strokesGroup.add(this.mesh);
    liveMaterials.push(this.material);

    if (halo && halo.widthMult > 0 && halo.opacity > 0) {
      this.haloGeometry = new MeshLineGeometry();
      this.haloMaterial = new MeshLineMaterial({
        color: new THREE.Color(color),
        lineWidth: width * halo.widthMult,
        resolution: resolution.clone(),
        sizeAttenuation: 1,
        opacity: halo.opacity,
      });
      this.haloMaterial.transparent = true;
      this.haloMaterial.depthTest = false;
      this.haloMaterial.depthWrite = false;
      this.haloMesh = new THREE.Mesh(this.haloGeometry, this.haloMaterial);
      this.haloMesh.frustumCulled = false;
      this.haloMesh.renderOrder = 1;
      strokesGroup.add(this.haloMesh);
      liveMaterials.push(this.haloMaterial);
    }
  }

  add(point: THREE.Vector3) {
    if (this.hasPoint && point.distanceTo(this.lastPoint) < MIN_MOVE_WORLD) return;
    this.appendPoint(point);
  }

  forceAdd(point: THREE.Vector3) {
    this.appendPoint(point);
  }

  addSpatter(origin: THREE.Vector3, color: string, baseSize: number, count: number) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
      mat.depthTest = false;
      mat.depthWrite = false;
      const m = new THREE.Mesh(SPATTER_GEOMETRY, mat);
      const spread = baseSize * (1.2 + Math.random() * 1.8);
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      m.position.set(origin.x + Math.cos(angle) * r, origin.y + Math.sin(angle) * r, origin.z);
      m.scale.setScalar(baseSize * (0.15 + Math.random() * 0.25));
      m.renderOrder = 2;
      strokesGroup.add(m);
      this.spatter.push(m);
    }
  }

  private appendPoint(point: THREE.Vector3) {
    this.points.push(point.clone());
    this.lastPoint.copy(point);
    this.hasPoint = true;
    const pts = this.points.length === 1 ? [this.points[0], this.points[0]] : this.points;
    if (this.widthFn) {
      this.geometry.setPoints(pts, this.widthFn);
    } else {
      this.geometry.setPoints(pts);
    }
    if (this.haloGeometry) {
      this.haloGeometry.setPoints(pts);
    }
  }

  dispose() {
    strokesGroup.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    let idx = liveMaterials.indexOf(this.material);
    if (idx >= 0) liveMaterials.splice(idx, 1);
    if (this.haloMesh && this.haloGeometry && this.haloMaterial) {
      strokesGroup.remove(this.haloMesh);
      this.haloGeometry.dispose();
      this.haloMaterial.dispose();
      idx = liveMaterials.indexOf(this.haloMaterial);
      if (idx >= 0) liveMaterials.splice(idx, 1);
    }
    for (const m of this.spatter) {
      strokesGroup.remove(m);
      (m.material as THREE.Material).dispose();
    }
    this.spatter.length = 0;
  }
}

class Drip {
  private stroke: Stroke;
  private path: THREE.Vector3[];
  private growSpeed: number;
  private elapsed = 0;
  private nextIndex = 1;
  finished = false;

  constructor(origin: THREE.Vector3, color: string, parentWidth: number, maxLen: number) {
    const segments = 14;
    const length = maxLen * (0.4 + Math.random() * 0.6);
    const phase = Math.random() * Math.PI * 2;
    const wobbleAmp = 0.006 + Math.random() * 0.006;
    this.path = [];
    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);
      const y = -length * t * t;
      const wobble = Math.sin(t * 6 + phase) * wobbleAmp * t;
      this.path.push(new THREE.Vector3(origin.x + wobble, origin.y + y, origin.z));
    }
    const width = parentWidth * (0.35 + Math.random() * 0.25);
    this.growSpeed = segments / (1.0 + Math.random() * 1.5);
    this.stroke = new Stroke(color, width, 'drip', (p) => 1 - p * 0.55);
    strokes.push(this.stroke);
    this.stroke.forceAdd(this.path[0]);
  }

  update(dt: number) {
    if (this.finished) return;
    this.elapsed += dt;
    const target = Math.min(this.path.length, Math.floor(this.elapsed * this.growSpeed) + 1);
    while (this.nextIndex < target) {
      this.stroke.forceAdd(this.path[this.nextIndex]);
      this.nextIndex++;
    }
    if (this.nextIndex >= this.path.length) this.finished = true;
  }
}

function showError(msg: string) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
}

async function requestOrientationPermission(): Promise<boolean> {
  const anyEvent = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (typeof anyEvent.requestPermission === 'function') {
    try {
      const res = await anyEvent.requestPermission();
      return res === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

function setupOrientation() {
  const zee = new THREE.Vector3(0, 0, 1);
  const euler = new THREE.Euler();
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

  const onOrient = (ev: DeviceOrientationEvent) => {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    const alpha = THREE.MathUtils.degToRad(ev.alpha);
    const beta = THREE.MathUtils.degToRad(ev.beta);
    const gamma = THREE.MathUtils.degToRad(ev.gamma);
    const orient = THREE.MathUtils.degToRad(screen.orientation?.angle ?? 0);

    euler.set(beta, alpha, -gamma, 'YXZ');
    deviceQuat.setFromEuler(euler);
    deviceQuat.multiply(q1);
    deviceQuat.multiply(q0.setFromAxisAngle(zee, -orient));
    orientationEnabled = true;
  };

  window.addEventListener('deviceorientation', onOrient, true);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resolution.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  for (const m of liveMaterials) {
    m.resolution.copy(resolution);
  }
}

function screenToWorld(clientX: number, clientY: number, out: THREE.Vector3): boolean {
  const rect = canvasEl.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  const hits = raycaster.intersectObject(drawSphere, false);
  if (hits.length === 0) return false;
  out.copy(hits[0].point);
  return true;
}

let activeStroke: Stroke | null = null;
let activeTouchId: number | null = null;
let lastAddTime = 0;
const drips: Drip[] = [];
const tmpVec = new THREE.Vector3();

function maybeSpawnDrip(at: THREE.Vector3) {
  if (currentTool.dripChance <= 0 || currentTool.dripMaxLen <= 0) return;
  if (Math.random() >= currentTool.dripChance) return;
  drips.push(new Drip(at, currentColor, currentWidth, currentTool.dripMaxLen));
}

function beginStroke(x: number, y: number) {
  const halo =
    currentTool.haloMult > 0
      ? { widthMult: currentTool.haloMult, opacity: currentTool.haloOpacity }
      : undefined;
  activeStroke = new Stroke(currentColor, currentWidth, 'main', undefined, halo);
  strokes.push(activeStroke);
  lastAddTime = performance.now();
  if (screenToWorld(x, y, tmpVec)) {
    activeStroke.add(tmpVec);
    maybeSpatter(activeStroke, tmpVec);
  }
}

function maybeSpatter(stroke: Stroke, at: THREE.Vector3) {
  if (currentTool.spatterChance <= 0 || currentTool.spatterCount <= 0) return;
  if (Math.random() >= currentTool.spatterChance) return;
  stroke.addSpatter(at, currentColor, currentWidth, currentTool.spatterCount);
}

function extendStroke(x: number, y: number) {
  if (!activeStroke) return;
  if (screenToWorld(x, y, tmpVec)) {
    const now = performance.now();
    if (now - lastAddTime >= currentTool.dwellMs) {
      maybeSpawnDrip(tmpVec);
    }
    activeStroke.add(tmpVec);
    maybeSpatter(activeStroke, tmpVec);
    lastAddTime = now;
  }
}

function endStroke() {
  if (activeStroke && activeStroke.points.length > 0) {
    const last = activeStroke.points[activeStroke.points.length - 1];
    maybeSpawnDrip(last);
  }
  activeStroke = null;
  activeTouchId = null;
}

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

function onTouchStart(ev: TouchEvent) {
  ev.preventDefault();
  if (activeTouchId !== null) return;
  const t = ev.changedTouches[0];
  if (!t) return;
  activeTouchId = t.identifier;
  beginStroke(t.clientX, t.clientY);
}

function onTouchMove(ev: TouchEvent) {
  ev.preventDefault();
  if (activeTouchId === null) return;
  const t = findTouch(ev.touches, activeTouchId);
  if (!t) return;
  extendStroke(t.clientX, t.clientY);
}

function onTouchEnd(ev: TouchEvent) {
  ev.preventDefault();
  if (activeTouchId === null) return;
  const t = findTouch(ev.changedTouches, activeTouchId);
  if (!t) return;
  endStroke();
}

let mouseDown = false;
function onMouseDown(ev: MouseEvent) {
  if (ev.button !== 0) return;
  mouseDown = true;
  beginStroke(ev.clientX, ev.clientY);
}
function onMouseMove(ev: MouseEvent) {
  if (!mouseDown) return;
  extendStroke(ev.clientX, ev.clientY);
}
function onMouseUp() {
  if (!mouseDown) return;
  mouseDown = false;
  endStroke();
}

function undo() {
  const s = strokes.pop();
  if (s) s.dispose();
}

function clearAll() {
  while (strokes.length) {
    const s = strokes.pop();
    if (s) s.dispose();
  }
  drips.length = 0;
}

function drawVideoCover(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  const canvasAR = w / h;
  const videoAR = vw / vh;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  if (videoAR > canvasAR) {
    sw = vh * canvasAR;
    sx = (vw - sw) / 2;
  } else {
    sh = vw / canvasAR;
    sy = (vh - sh) / 2;
  }
  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, w, h);
}

async function saveImage() {
  const pr = renderer.getPixelRatio();
  const w = Math.floor(window.innerWidth * pr);
  const h = Math.floor(window.innerHeight * pr);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return;

  drawVideoCover(ctx, w, h);
  renderer.render(scene, camera);
  ctx.drawImage(renderer.domElement, 0, 0, w, h);

  const blob: Blob | null = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const filename = `fede-graff-${Date.now()}.png`;
  const file = new File([blob], filename, { type: 'image/png' });

  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Fede Graff' });
      return;
    } catch {
      // user cancelled or share failed — fall through to download
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function buildToolbar() {
  const sizeInput = document.createElement('input');
  sizeInput.type = 'range';
  sizeInput.min = '0.02';
  sizeInput.max = '0.18';
  sizeInput.step = '0.005';
  sizeInput.value = String(currentWidth);

  const preview = document.createElement('div');
  preview.id = 'sizePreview';

  const updatePreview = () => {
    const pct = (currentWidth - 0.02) / (0.18 - 0.02);
    const size = 6 + pct * 22;
    preview.style.width = `${size}px`;
    preview.style.height = `${size}px`;
    preview.style.background = currentColor;
  };

  sizeInput.addEventListener('input', () => {
    currentWidth = Number(sizeInput.value);
    updatePreview();
  });

  for (const tool of TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.textContent = tool.label;
    if (tool.id === currentTool.id) b.classList.add('on');
    b.addEventListener('click', () => {
      currentTool = tool;
      currentWidth = tool.width;
      sizeInput.value = String(tool.width);
      updatePreview();
      toolsEl.querySelectorAll('.tool').forEach((n) => n.classList.remove('on'));
      b.classList.add('on');
    });
    toolsEl.appendChild(b);
  }

  for (const c of COLORS) {
    const el = document.createElement('div');
    el.className = 'swatch';
    el.style.background = c;
    if (c === currentColor) el.classList.add('on');
    el.addEventListener('click', () => {
      currentColor = c;
      updatePreview();
      colorsEl.querySelectorAll('.swatch').forEach((n) => n.classList.remove('on'));
      el.classList.add('on');
    });
    colorsEl.appendChild(el);
  }

  const label = document.createElement('label');
  label.textContent = 'Tamaño';
  sizeEl.appendChild(label);
  sizeEl.appendChild(sizeInput);
  sizeEl.appendChild(preview);
  updatePreview();
}

let lastTickTime = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTickTime) / 1000);
  lastTickTime = now;
  if (orientationEnabled) {
    camera.quaternion.copy(deviceQuat);
  }
  for (let i = drips.length - 1; i >= 0; i--) {
    drips[i].update(dt);
    if (drips[i].finished) drips.splice(i, 1);
  }
  renderer.render(scene, camera);
}

async function start() {
  startBtn.disabled = true;
  try {
    const granted = await requestOrientationPermission();
    if (!granted) {
      showError('Necesitamos permiso de orientación. Recargá y aceptá.');
      return;
    }
    setupOrientation();
    await startCamera();
    startEl.style.display = 'none';
    toolbarEl.classList.add('on');
    actionsEl.classList.add('on');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`No pudimos iniciar la cámara: ${message}`);
    startBtn.disabled = false;
  }
}

buildToolbar();
resize();
tick();

window.addEventListener('resize', resize);
screen.orientation?.addEventListener?.('change', resize);
startBtn.addEventListener('click', start);
undoBtn.addEventListener('click', undo);
clearBtn.addEventListener('click', clearAll);
saveBtn.addEventListener('click', () => {
  void saveImage();
});
canvasEl.addEventListener('touchstart', onTouchStart, { passive: false });
canvasEl.addEventListener('touchmove', onTouchMove, { passive: false });
canvasEl.addEventListener('touchend', onTouchEnd, { passive: false });
canvasEl.addEventListener('touchcancel', onTouchEnd, { passive: false });
canvasEl.addEventListener('mousedown', onMouseDown);
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);
