import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import "./styles.css";

type FaceKey = "left" | "right" | "top" | "bottom";

interface LampParams {
  boxWidth: number;
  boxHeight: number;
  boxDepth: number;
  wallThickness: number;
  projectionScale: number;
  lightDistance: number;
  lightBrightness: number;
  sensitivity: number;
  wallResolution: number;
  minFeature: number;
  invert: boolean;
  keepFrontRim: boolean;
  keepCornerRims: boolean;
}

interface ProjectionStats {
  targetPixels: number;
  projectedPixels: number;
  blockedPixels: number;
  invalidPixels: number;
  floatingCells: number;
  floatingComponents: number;
  isFullyConnected: boolean;
}

interface ProjectionResult {
  masks: Record<FaceKey, Uint8Array>;
  stats: ProjectionStats;
}

interface ImageMask {
  size: number;
  data: Uint8Array;
  label: string;
}

const IMAGE_MASK_SIZE = 480;
const MODEL_RESOLUTION_CAP = 220;
const LAMP_POST_DIAMETER_MM = 3;

const FACE_KEYS: FaceKey[] = ["left", "right", "top", "bottom"];
const FACE_LABELS: Record<FaceKey, string> = {
  left: "左壁",
  right: "右壁",
  top: "顶壁",
  bottom: "底壁",
};

const params: LampParams = {
  boxWidth: 100,
  boxHeight: 100,
  boxDepth: 50,
  wallThickness: 3,
  projectionScale: 10,
  lightDistance: 55,
  lightBrightness: 3,
  sensitivity: 18,
  wallResolution: 180,
  minFeature: 1.2,
  invert: true,
  keepFrontRim: false,
  keepCornerRims: false,
};

let sourceImage: HTMLImageElement | null = null;
let imageMask: ImageMask = createDefaultMask(IMAGE_MASK_SIZE);
if (params.invert) {
  imageMask.data = invertMask(imageMask.data);
}
let projection: ProjectionResult | null = null;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root");
}

app.innerHTML = `
  <main class="app-shell">
    <aside class="sidebar">
      <section class="brand">
        <h1>影灯设计师 MVP</h1>
        <p>矩形贴墙灯盒，背板遮挡区默认可见。</p>
      </section>

      <section class="panel">
        <h2>图片</h2>
        <div class="drop-zone" id="dropZone" role="button" tabindex="0">
          <input class="file-input" id="fileInput" type="file" accept="image/png,image/jpeg,image/webp" />
          <span><strong>上传或拖拽图片</strong>JPG / PNG / WEBP，本地处理</span>
        </div>
        <canvas class="preview-canvas" id="targetCanvas" width="360" height="360"></canvas>
        <label class="checkbox-label">
          <input id="invertInput" type="checkbox" />
          反转前景/背景
        </label>
        <div class="control">
          <div class="control-row">
            <label for="sensitivityInput">背景灵敏度</label>
            <span class="value" id="sensitivityValue"></span>
          </div>
          <input id="sensitivityInput" type="range" min="5" max="120" step="1" />
        </div>
      </section>

      <section class="panel">
        <h2>灯盒参数</h2>
        ${rangeControl("boxWidth", "盒子宽度", 30, 300, 1)}
        ${rangeControl("boxHeight", "盒子高度", 30, 300, 1)}
        ${rangeControl("boxDepth", "盒子深度", 20, 150, 1)}
        ${rangeControl("wallThickness", "壁厚", 1.2, 5, 0.1)}
        ${rangeControl("wallResolution", "镂空采样精度", 80, 320, 10)}
        ${rangeControl("minFeature", "最小特征", 0.8, 3, 0.1)}
      </section>

      <section class="panel">
        <h2>壁面 mask</h2>
        <div class="mask-grid">
          ${FACE_KEYS.map(
            (key) => `
              <div class="mask-tile">
                <span>${FACE_LABELS[key]}</span>
                <canvas id="${key}MaskCanvas" width="96" height="96"></canvas>
              </div>
            `,
          ).join("")}
        </div>
      </section>

      <section class="panel">
        <h2>状态</h2>
        <div class="stats">
          <div class="stat"><strong id="projectedStat">0%</strong><span>可投影比例</span></div>
          <div class="stat"><strong id="blockedStat">0%</strong><span>遮挡/丢弃</span></div>
          <div class="stat"><strong id="cellStat">0</strong><span>壁面网格</span></div>
          <div class="stat"><strong id="sourceStat">示例</strong><span>当前图片</span></div>
          <div class="stat"><strong id="connectStat">--</strong><span>全局连通</span></div>
          <div class="stat"><strong id="floatingStat">0</strong><span>悬浮组件</span></div>
        </div>
        <div class="actions">
          <button class="button" id="exportButton">导出 STL</button>
          <button class="button secondary" id="resetButton">重置示例</button>
        </div>
      </section>
    </aside>

    <section class="viewer" id="viewer">
      <div class="viewer-controls">
        <div class="viewer-controls-head">
          <strong>投影控制</strong>
          <span>直接影响墙面预览</span>
        </div>
        ${rangeControl("projectionScale", "墙面投影倍率", 5, 20, 0.1)}
        ${rangeControl("lightDistance", "光源距墙高度", 3, 75, 1)}
        ${rangeControl("lightBrightness", "光源亮度", 0.2, 3, 0.1)}
        <div class="rim-options">
          <label class="checkbox-label compact-check">
            <input id="keepFrontRimInput" type="checkbox" />
            保留正面边框
          </label>
          <label class="checkbox-label compact-check">
            <input id="keepCornerRimsInput" type="checkbox" />
            保留四角边框
          </label>
        </div>
      </div>
      <div class="hud">
        <b>当前 MVP：</b>四侧壁镂空、实心背板、正面开放。墙面中心半透明区域表示背板遮挡，投影轮廓围绕灯盒展开。
      </div>
    </section>
  </main>
`;

function rangeControl(
  id: keyof Omit<LampParams, "invert" | "keepFrontRim" | "keepCornerRims">,
  label: string,
  min: number,
  max: number,
  step: number,
) {
  return `
    <div class="control">
      <div class="control-row">
        <label for="${id}Input">${label}</label>
        <span class="value" id="${id}Value"></span>
      </div>
      <input id="${id}Input" type="range" min="${min}" max="${max}" step="${step}" />
    </div>
  `;
}

const targetCanvas = getCanvas("targetCanvas");
const sensitivityInput = getInput("sensitivityInput");
const invertInput = getInput("invertInput");
const keepFrontRimInput = getInput("keepFrontRimInput");
const keepCornerRimsInput = getInput("keepCornerRimsInput");
const fileInput = getInput("fileInput");
const dropZone = getElement<HTMLDivElement>("dropZone");
const exportButton = getElement<HTMLButtonElement>("exportButton");
const resetButton = getElement<HTMLButtonElement>("resetButton");

const scene = new THREE.Scene();
scene.background = new THREE.Color("#101522");

const viewer = getElement<HTMLDivElement>("viewer");
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
let renderer: THREE.WebGLRenderer | null = null;
let controls: OrbitControls | null = null;
let pointLight: THREE.PointLight | null = null;
let fallbackCanvas: HTMLCanvasElement | null = null;
let viewerMessage: HTMLDivElement | null = null;
let has3D = false;

let modelGroup = new THREE.Group();
scene.add(modelGroup);

const resizeObserver = new ResizeObserver(() => resizeRenderer());
resizeObserver.observe(viewer);

has3D = init3D();

function bindControls() {
  const numericKeys: (keyof Omit<LampParams, "invert" | "keepFrontRim" | "keepCornerRims">)[] = [
    "boxWidth",
    "boxHeight",
    "boxDepth",
    "wallThickness",
    "projectionScale",
    "lightDistance",
    "lightBrightness",
    "wallResolution",
    "minFeature",
  ];

  for (const key of numericKeys) {
    getInput(`${key}Input`).addEventListener("input", (event) => {
      const previousDepth = params.boxDepth;
      const wasDefaultLightDistance = Math.abs(params.lightDistance - (previousDepth + 5)) < 0.001;
      params[key] = Number((event.target as HTMLInputElement).value);
      if (key === "boxDepth" && wasDefaultLightDistance) {
        params.lightDistance = params.boxDepth + 5;
      }
      clampDynamicParams();
      syncInputs();
      scheduleRebuild();
    });
  }

  sensitivityInput.addEventListener("input", (event) => {
    params.sensitivity = Number((event.target as HTMLInputElement).value);
    if (sourceImage) {
      imageMask = processImageToMask(sourceImage, params.sensitivity, params.invert);
    } else {
      imageMask = createDefaultMask(IMAGE_MASK_SIZE);
      if (params.invert) {
        imageMask.data = invertMask(imageMask.data);
      }
    }
    syncInputs();
    scheduleRebuild();
  });

  invertInput.addEventListener("change", (event) => {
    params.invert = (event.target as HTMLInputElement).checked;
    if (sourceImage) {
      imageMask = processImageToMask(sourceImage, params.sensitivity, params.invert);
    } else {
      imageMask = createDefaultMask(IMAGE_MASK_SIZE);
      if (params.invert) {
        imageMask.data = invertMask(imageMask.data);
      }
    }
    scheduleRebuild();
  });

  keepFrontRimInput.addEventListener("change", (event) => {
    params.keepFrontRim = (event.target as HTMLInputElement).checked;
    scheduleRebuild();
  });

  keepCornerRimsInput.addEventListener("change", (event) => {
    params.keepCornerRims = (event.target as HTMLInputElement).checked;
    scheduleRebuild();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
      void loadFile(file);
    }
  });

  dropZone.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.value = "";
      fileInput.click();
    }
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("is-dragging");
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void loadFile(file);
    }
  });

  resetButton.addEventListener("click", () => {
    sourceImage = null;
    imageMask = createDefaultMask(IMAGE_MASK_SIZE);
    if (params.invert) {
      imageMask.data = invertMask(imageMask.data);
    }
    fileInput.value = "";
    scheduleRebuild();
  });

  exportButton.addEventListener("click", () => exportStl());
}

let rebuildTimer = 0;
function scheduleRebuild() {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => rebuildAll(), 80);
}

function rebuildAll() {
  projection = computeProjection(imageMask, params);
  drawTargetPreview();
  drawMaskPreviews();
  updateStats();
  rebuildScene();
}

function syncInputs() {
  getInput("lightDistanceInput").max = String(params.boxDepth * 1.5);
  setRange("boxWidth", params.boxWidth, "mm");
  setRange("boxHeight", params.boxHeight, "mm");
  setRange("boxDepth", params.boxDepth, "mm");
  setRange("wallThickness", params.wallThickness, "mm");
  setRange("projectionScale", params.projectionScale, "x");
  setRange("lightDistance", params.lightDistance, "mm");
  setRange("lightBrightness", params.lightBrightness, "x");
  setRange("wallResolution", params.wallResolution, "");
  setRange("minFeature", params.minFeature, "mm");
  sensitivityInput.value = String(params.sensitivity);
  getElement("sensitivityValue").textContent = String(params.sensitivity);
  invertInput.checked = params.invert;
  keepFrontRimInput.checked = params.keepFrontRim;
  keepCornerRimsInput.checked = params.keepCornerRims;
}

function clampDynamicParams() {
  params.lightDistance = clamp(params.lightDistance, 3, params.boxDepth * 1.5);
}

function setRange(
  key: keyof Omit<LampParams, "invert" | "keepFrontRim" | "keepCornerRims">,
  value: number,
  suffix: string,
) {
  getInput(`${key}Input`).value = String(value);
  getElement(`${key}Value`).textContent = `${formatNumber(value)}${suffix}`;
}

async function loadFile(file: File) {
  const image = new Image();
  image.decoding = "async";
  image.src = URL.createObjectURL(file);
  await image.decode();
  URL.revokeObjectURL(image.src);
  sourceImage = image;
  imageMask = processImageToMask(image, params.sensitivity, params.invert, file.name);
  scheduleRebuild();
}

function processImageToMask(
  image: HTMLImageElement,
  sensitivity: number,
  invert: boolean,
  label = "上传图片",
): ImageMask {
  const size = IMAGE_MASK_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = get2d(canvas);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  const scale = Math.min(size / image.width, size / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);

  const pixels = ctx.getImageData(0, 0, size, size);
  const bg = detectBackgroundColor(pixels.data, size, size);
  const mask = new Uint8Array(size * size);

  for (let i = 0; i < size * size; i += 1) {
    const r = pixels.data[i * 4];
    const g = pixels.data[i * 4 + 1];
    const b = pixels.data[i * 4 + 2];
    const a = pixels.data[i * 4 + 3] / 255;
    const dist = Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2);
    const foreground = a > 0.1 && dist > sensitivity;
    mask[i] = invert ? Number(!foreground) : Number(foreground);
  }

  // 清理锯齿和毛刺：形态学平滑 + 小连通域剔除。
  let cleanedMask = smoothBinaryMask(mask, size);
  const minArea = Math.max(18, Math.round(size * size * 0.00008));
  cleanedMask = removeSmallComponents(cleanedMask, size, minArea);

  return {
    size,
    data: cleanedMask,
    label,
  };
}

function detectBackgroundColor(data: Uint8ClampedArray, width: number, height: number) {
  const samples: number[][] = [];
  const push = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };

  for (let i = 0; i < width; i += 4) {
    push(i, 0);
    push(i, height - 1);
  }
  for (let y = 0; y < height; y += 4) {
    push(0, y);
    push(width - 1, y);
  }

  return [median(samples.map((s) => s[0])), median(samples.map((s) => s[1])), median(samples.map((s) => s[2]))];
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 255;
}

function createDefaultMask(size: number): ImageMask {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = get2d(canvas);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  drawStar(ctx, size * 0.5, size * 0.5, size * 0.38, size * 0.16, 5);
  ctx.fill();
  ctx.fillRect(size * 0.47, size * 0.12, size * 0.06, size * 0.76);
  ctx.fillRect(size * 0.12, size * 0.47, size * 0.76, size * 0.06);
  const pixels = ctx.getImageData(0, 0, size, size);
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = pixels.data[i * 4] > 20 ? 1 : 0;
  }
  return { size, data, label: "内置示例" };
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points: number,
) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function computeProjection(mask: ImageMask, lamp: LampParams): ProjectionResult {
  const res = lamp.wallResolution;
  const masks: Record<FaceKey, Uint8Array> = {
    left: new Uint8Array(res * res),
    right: new Uint8Array(res * res),
    top: new Uint8Array(res * res),
    bottom: new Uint8Array(res * res),
  };

  const stats: ProjectionStats = {
    targetPixels: 0,
    projectedPixels: 0,
    blockedPixels: 0,
    invalidPixels: 0,
    floatingCells: 0,
    floatingComponents: 0,
    isFullyConnected: true,
  };

  const projectionWidth = lamp.boxWidth * lamp.projectionScale;
  const projectionHeight = lamp.boxHeight * lamp.projectionScale;
  const lightZ = getLightZ(lamp);
  const brush = res >= 180 ? 1 : Math.max(1, Math.round(res / 140));

  for (let py = 0; py < mask.size; py += 1) {
    for (let px = 0; px < mask.size; px += 1) {
      const sourceIndex = py * mask.size + px;
      if (!mask.data[sourceIndex]) {
        continue;
      }

      stats.targetPixels += 1;

      const xWall = (px / (mask.size - 1) - 0.5) * projectionWidth;
      const yWall = (0.5 - py / (mask.size - 1)) * projectionHeight;

      if (Math.abs(xWall) <= lamp.boxWidth / 2 && Math.abs(yWall) <= lamp.boxHeight / 2) {
        stats.blockedPixels += 1;
        continue;
      }

      const hit = traceToFace(xWall, yWall, lightZ, lamp);
      if (!hit) {
        stats.invalidPixels += 1;
        continue;
      }

      const col = Math.round(hit.u * (res - 1));
      const row = Math.round((1 - hit.v) * (res - 1));
      stamp(masks[hit.face], res, col, row, brush);
      stats.projectedPixels += 1;
    }
  }

  for (const face of FACE_KEYS) {
    const faceWidth = face === "left" || face === "right" ? lamp.boxHeight : lamp.boxWidth;
    const xRimCells = Math.max(1, Math.ceil(lamp.minFeature / (faceWidth / res)));
    const zRimCells = Math.max(1, Math.ceil(lamp.minFeature / (lamp.boxDepth / res)));
    masks[face] = enforcePrintableWallMask(
      masks[face],
      res,
      xRimCells,
      zRimCells,
      lamp.keepFrontRim,
      lamp.keepCornerRims,
    );
  }

  const globalFiltered = applyGlobalConnectivityFilter(masks, res, lamp);
  for (const face of FACE_KEYS) {
    masks[face] = globalFiltered.masks[face];
  }
  stats.floatingCells = globalFiltered.floatingCells;
  stats.floatingComponents = globalFiltered.floatingComponents;
  stats.isFullyConnected = globalFiltered.floatingComponents === 0;

  return { masks, stats };
}

function traceToFace(
  xWall: number,
  yWall: number,
  lightZ: number,
  lamp: LampParams,
): { face: FaceKey; u: number; v: number } | null {
  const candidates: { face: FaceKey; s: number; x: number; y: number; z: number }[] = [];

  const addCandidate = (face: FaceKey, s: number) => {
    if (s <= 0 || s >= 1 || !Number.isFinite(s)) {
      return;
    }
    const x = xWall * s;
    const y = yWall * s;
    const z = lightZ * (1 - s);
    if (z < 0 || z > lamp.boxDepth) {
      return;
    }
    if (Math.abs(x) <= lamp.boxWidth / 2 + 0.001 && Math.abs(y) <= lamp.boxHeight / 2 + 0.001) {
      candidates.push({ face, s, x, y, z });
    }
  };

  if (xWall > lamp.boxWidth / 2) {
    addCandidate("right", lamp.boxWidth / 2 / xWall);
  }
  if (xWall < -lamp.boxWidth / 2) {
    addCandidate("left", -lamp.boxWidth / 2 / xWall);
  }
  if (yWall > lamp.boxHeight / 2) {
    addCandidate("top", lamp.boxHeight / 2 / yWall);
  }
  if (yWall < -lamp.boxHeight / 2) {
    addCandidate("bottom", -lamp.boxHeight / 2 / yWall);
  }

  candidates.sort((a, b) => a.s - b.s);
  const hit = candidates[0];
  if (!hit) {
    return null;
  }

  if (hit.face === "left" || hit.face === "right") {
    return {
      face: hit.face,
      u: clamp((hit.y + lamp.boxHeight / 2) / lamp.boxHeight, 0, 1),
      v: clamp(hit.z / lamp.boxDepth, 0, 1),
    };
  }

  return {
    face: hit.face,
    u: clamp((hit.x + lamp.boxWidth / 2) / lamp.boxWidth, 0, 1),
    v: clamp(hit.z / lamp.boxDepth, 0, 1),
  };
}

function stamp(mask: Uint8Array, size: number, cx: number, cy: number, radius: number) {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (x >= 0 && x < size && y >= 0 && y < size) {
        mask[y * size + x] = 1;
      }
    }
  }
}

function enforcePrintableWallMask(
  openMask: Uint8Array,
  size: number,
  xRimCells: number,
  zRimCells: number,
  keepFrontRim: boolean,
  keepCornerRims: boolean,
) {
  const solid = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cornerRim = keepCornerRims && (x < xRimCells || x >= size - xRimCells);
      const backRim = y >= size - zRimCells;
      const frontRim = keepFrontRim && y < zRimCells;
      const border = cornerRim || backRim || frontRim;
      solid[y * size + x] = border || !openMask[y * size + x] ? 1 : 0;
    }
  }

  const connected = floodFillBorderSolids(solid, size, {
    front: keepFrontRim,
    sides: keepCornerRims,
    back: true,
  });
  const cleanedOpen = new Uint8Array(size * size);
  for (let i = 0; i < cleanedOpen.length; i += 1) {
    cleanedOpen[i] = connected[i] ? 0 : 1;
  }

  if (!keepFrontRim) {
    for (let y = 0; y < zRimCells; y += 1) {
      for (let x = 0; x < size; x += 1) {
        cleanedOpen[y * size + x] = 1;
      }
    }
  }

  return cleanedOpen;
}

function applyGlobalConnectivityFilter(masks: Record<FaceKey, Uint8Array>, size: number, lamp: LampParams) {
  const solids: Record<FaceKey, Uint8Array> = {
    left: new Uint8Array(size * size),
    right: new Uint8Array(size * size),
    top: new Uint8Array(size * size),
    bottom: new Uint8Array(size * size),
  };
  for (const face of FACE_KEYS) {
    for (let i = 0; i < size * size; i += 1) {
      solids[face][i] = masks[face][i] ? 0 : 1;
    }
  }

  const backCells = Math.max(1, Math.ceil(lamp.minFeature / (lamp.boxDepth / size)));
  const connected = floodFillGlobalConnected(solids, size, backCells);
  const filteredMasks: Record<FaceKey, Uint8Array> = {
    left: new Uint8Array(size * size),
    right: new Uint8Array(size * size),
    top: new Uint8Array(size * size),
    bottom: new Uint8Array(size * size),
  };

  let floatingCells = 0;
  for (const face of FACE_KEYS) {
    for (let i = 0; i < size * size; i += 1) {
      const isSolid = solids[face][i] === 1;
      const keep = connected[face][i] === 1;
      filteredMasks[face][i] = isSolid && keep ? 0 : 1;
      if (isSolid && !keep) {
        floatingCells += 1;
      }
    }
  }

  const floatingComponents = countFloatingComponents(solids, connected, size);
  return { masks: filteredMasks, floatingCells, floatingComponents };
}

function floodFillGlobalConnected(
  solids: Record<FaceKey, Uint8Array>,
  size: number,
  backCells: number,
) {
  const visited: Record<FaceKey, Uint8Array> = {
    left: new Uint8Array(size * size),
    right: new Uint8Array(size * size),
    top: new Uint8Array(size * size),
    bottom: new Uint8Array(size * size),
  };
  const queue: Array<{ face: FaceKey; row: number; col: number }> = [];

  const push = (face: FaceKey, row: number, col: number) => {
    if (row < 0 || row >= size || col < 0 || col >= size) {
      return;
    }
    const index = row * size + col;
    if (!solids[face][index] || visited[face][index]) {
      return;
    }
    visited[face][index] = 1;
    queue.push({ face, row, col });
  };

  for (const face of FACE_KEYS) {
    for (let row = size - backCells; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        push(face, row, col);
      }
    }
  }

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const neighbors = getGlobalNeighbors(current.face, current.row, current.col, size);
    for (const neighbor of neighbors) {
      push(neighbor.face, neighbor.row, neighbor.col);
    }
  }

  return visited;
}

function getGlobalNeighbors(face: FaceKey, row: number, col: number, size: number) {
  const out: Array<{ face: FaceKey; row: number; col: number }> = [];
  out.push({ face, row: row - 1, col });
  out.push({ face, row: row + 1, col });
  out.push({ face, row, col: col - 1 });
  out.push({ face, row, col: col + 1 });

  if (face === "left") {
    if (col === size - 1) out.push({ face: "top", row, col: 0 });
    if (col === 0) out.push({ face: "bottom", row, col: 0 });
  } else if (face === "right") {
    if (col === size - 1) out.push({ face: "top", row, col: size - 1 });
    if (col === 0) out.push({ face: "bottom", row, col: size - 1 });
  } else if (face === "top") {
    if (col === 0) out.push({ face: "left", row, col: size - 1 });
    if (col === size - 1) out.push({ face: "right", row, col: size - 1 });
  } else if (face === "bottom") {
    if (col === 0) out.push({ face: "left", row, col: 0 });
    if (col === size - 1) out.push({ face: "right", row, col: 0 });
  }

  return out;
}

function countFloatingComponents(
  solids: Record<FaceKey, Uint8Array>,
  connected: Record<FaceKey, Uint8Array>,
  size: number,
) {
  const seen: Record<FaceKey, Uint8Array> = {
    left: new Uint8Array(size * size),
    right: new Uint8Array(size * size),
    top: new Uint8Array(size * size),
    bottom: new Uint8Array(size * size),
  };
  const queue: Array<{ face: FaceKey; row: number; col: number }> = [];
  let components = 0;

  const canVisit = (face: FaceKey, row: number, col: number) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return false;
    const index = row * size + col;
    return solids[face][index] === 1 && connected[face][index] === 0 && seen[face][index] === 0;
  };

  for (const face of FACE_KEYS) {
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (!canVisit(face, row, col)) continue;
        components += 1;
        queue.length = 0;
        queue.push({ face, row, col });
        seen[face][row * size + col] = 1;
        for (let head = 0; head < queue.length; head += 1) {
          const current = queue[head];
          const neighbors = getGlobalNeighbors(current.face, current.row, current.col, size);
          for (const neighbor of neighbors) {
            if (!canVisit(neighbor.face, neighbor.row, neighbor.col)) continue;
            seen[neighbor.face][neighbor.row * size + neighbor.col] = 1;
            queue.push(neighbor);
          }
        }
      }
    }
  }
  return components;
}

function floodFillBorderSolids(
  solid: Uint8Array,
  size: number,
  seeds: { front: boolean; sides: boolean; back: boolean },
) {
  const visited = new Uint8Array(size * size);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || x >= size || y < 0 || y >= size) {
      return;
    }
    const index = y * size + x;
    if (solid[index] && !visited[index]) {
      visited[index] = 1;
      queue.push(index);
    }
  };

  for (let i = 0; i < size; i += 1) {
    if (seeds.front) {
      push(i, 0);
    }
    if (seeds.back) {
      push(i, size - 1);
    }
    if (seeds.sides) {
      push(0, i);
      push(size - 1, i);
    }
  }

  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const x = index % size;
    const y = Math.floor(index / size);
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return visited;
}

function rebuildScene() {
  if (!has3D || !renderer || !controls || !pointLight) {
    drawFallbackPreview();
    return;
  }
  scene.remove(modelGroup);
  disposeObject(modelGroup);
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  if (!projection) {
    return;
  }

  const solidMaterial = new THREE.MeshStandardMaterial({
    color: "#8d99a8",
    roughness: 0.72,
    metalness: 0.04,
  });
  const backMaterial = new THREE.MeshStandardMaterial({
    color: "#596579",
    roughness: 0.8,
  });
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: "#222a3a",
    roughness: 0.95,
  });
  const blockMaterial = new THREE.MeshBasicMaterial({
    color: "#ff7b7b",
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
  });

  const projectionSize = getProjectionSize(params);
  const wallPadding = 1.18;
  const wallPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(projectionSize.width * wallPadding, projectionSize.height * wallPadding),
    wallMaterial,
  );
  wallPlane.position.z = -2;
  wallPlane.receiveShadow = true;
  modelGroup.add(wallPlane);

  const blockedPlane = new THREE.Mesh(new THREE.PlaneGeometry(params.boxWidth, params.boxHeight), blockMaterial);
  blockedPlane.position.z = -1.5;
  modelGroup.add(blockedPlane);

  const geometry = buildLampGeometry(projection.masks, params, getModelResolution(params.wallResolution));
  const lampMesh = new THREE.Mesh(geometry, solidMaterial);
  lampMesh.castShadow = true;
  lampMesh.receiveShadow = true;
  lampMesh.name = "shadow-lamp-body";
  modelGroup.add(lampMesh);

  const backPlate = new THREE.Mesh(
    new THREE.BoxGeometry(
      params.boxWidth + params.wallThickness * 2,
      params.boxHeight + params.wallThickness * 2,
      params.wallThickness,
    ),
    backMaterial,
  );
  backPlate.position.z = params.wallThickness / 2;
  backPlate.castShadow = true;
  backPlate.receiveShadow = true;
  backPlate.name = "solid-back-plate";
  modelGroup.add(backPlate);

  const lightZ = getLightZ(params);
  pointLight.position.set(0, 0, lightZ);
  pointLight.intensity = Math.max(1500, params.boxDepth * 180 * params.lightBrightness);
  pointLight.distance = Math.max(params.boxWidth, params.boxHeight) * params.projectionScale * 1.8;

  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(2.5, params.boxWidth * 0.035), 24, 16),
    new THREE.MeshBasicMaterial({ color: "#ffe9a8" }),
  );
  bulb.position.copy(pointLight.position);
  modelGroup.add(bulb);

  fitCamera();
}

function buildLampGeometry(masks: Record<FaceKey, Uint8Array>, lamp: LampParams, modelRes: number) {
  const builder = new GeometryBuilder();
  addWall(builder, masks.left, lamp.wallResolution, modelRes, "left", lamp);
  addWall(builder, masks.right, lamp.wallResolution, modelRes, "right", lamp);
  addWall(builder, masks.top, lamp.wallResolution, modelRes, "top", lamp);
  addWall(builder, masks.bottom, lamp.wallResolution, modelRes, "bottom", lamp);
  return builder.toGeometry();
}

function addWall(
  builder: GeometryBuilder,
  sourceMask: Uint8Array,
  sourceRes: number,
  res: number,
  face: FaceKey,
  lamp: LampParams,
) {
  const faceWidth = face === "left" || face === "right" ? lamp.boxHeight : lamp.boxWidth;
  const cellU = faceWidth / res;
  const cellZ = lamp.boxDepth / res;
  const sampled = resampleMask(sourceMask, sourceRes, res);

  for (let row = 0; row < res; row += 1) {
    let col = 0;
    while (col < res) {
      while (col < res && sampled[row * res + col]) {
        col += 1;
      }
      const runStart = col;
      while (col < res && !sampled[row * res + col]) {
        col += 1;
      }
      const runEnd = col;
      if (runEnd <= runStart) {
        continue;
      }

      const runCells = runEnd - runStart;
      const uCenter = (runStart + runCells / 2) * cellU - faceWidth / 2;
      const zCenter = (res - row - 0.5) * cellZ;

      if (face === "left") {
        builder.addBox(
          [-lamp.boxWidth / 2 - lamp.wallThickness / 2, uCenter, zCenter],
          [lamp.wallThickness, runCells * cellU, cellZ],
        );
      } else if (face === "right") {
        builder.addBox(
          [lamp.boxWidth / 2 + lamp.wallThickness / 2, uCenter, zCenter],
          [lamp.wallThickness, runCells * cellU, cellZ],
        );
      } else if (face === "top") {
        builder.addBox(
          [uCenter, lamp.boxHeight / 2 + lamp.wallThickness / 2, zCenter],
          [runCells * cellU, lamp.wallThickness, cellZ],
        );
      } else {
        builder.addBox(
          [uCenter, -lamp.boxHeight / 2 - lamp.wallThickness / 2, zCenter],
          [runCells * cellU, lamp.wallThickness, cellZ],
        );
      }
    }
  }
}

class GeometryBuilder {
  private vertices: number[] = [];
  private indices: number[] = [];

  addBox(center: [number, number, number], size: [number, number, number]) {
    const [cx, cy, cz] = center;
    const [sx, sy, sz] = size.map((v) => v / 2) as [number, number, number];
    const points: [number, number, number][] = [
      [cx - sx, cy - sy, cz - sz],
      [cx + sx, cy - sy, cz - sz],
      [cx + sx, cy + sy, cz - sz],
      [cx - sx, cy + sy, cz - sz],
      [cx - sx, cy - sy, cz + sz],
      [cx + sx, cy - sy, cz + sz],
      [cx + sx, cy + sy, cz + sz],
      [cx - sx, cy + sy, cz + sz],
    ];
    const faces = [
      [0, 2, 1, 0, 3, 2],
      [4, 5, 6, 4, 6, 7],
      [0, 1, 5, 0, 5, 4],
      [1, 2, 6, 1, 6, 5],
      [2, 3, 7, 2, 7, 6],
      [3, 0, 4, 3, 4, 7],
    ];
    const offset = this.vertices.length / 3;
    for (const point of points) {
      this.vertices.push(...point);
    }
    for (const face of faces) {
      for (const index of face) {
        this.indices.push(offset + index);
      }
    }
  }

  toGeometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.vertices, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function resampleMask(mask: Uint8Array, sourceRes: number, targetRes: number) {
  if (sourceRes === targetRes) {
    return mask;
  }
  const out = new Uint8Array(targetRes * targetRes);
  const scale = sourceRes / targetRes;
  const threshold = 0.45;
  for (let y = 0; y < targetRes; y += 1) {
    const y0 = y * scale;
    const y1 = (y + 1) * scale;
    const syStart = Math.floor(y0);
    const syEnd = Math.min(sourceRes, Math.ceil(y1));
    for (let x = 0; x < targetRes; x += 1) {
      const x0 = x * scale;
      const x1 = (x + 1) * scale;
      const sxStart = Math.floor(x0);
      const sxEnd = Math.min(sourceRes, Math.ceil(x1));

      let weightedSum = 0;
      let totalWeight = 0;
      for (let sy = syStart; sy < syEnd; sy += 1) {
        const yWeight = overlapLength(y0, y1, sy, sy + 1);
        if (yWeight <= 0) continue;
        for (let sx = sxStart; sx < sxEnd; sx += 1) {
          const xWeight = overlapLength(x0, x1, sx, sx + 1);
          if (xWeight <= 0) continue;
          const weight = xWeight * yWeight;
          weightedSum += mask[sy * sourceRes + sx] * weight;
          totalWeight += weight;
        }
      }
      const coverage = totalWeight > 0 ? weightedSum / totalWeight : 0;
      out[y * targetRes + x] = coverage >= threshold ? 1 : 0;
    }
  }
  return out;
}

function drawTargetPreview() {
  const ctx = get2d(targetCanvas);
  const size = targetCanvas.width;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#080b12";
  ctx.fillRect(0, 0, size, size);

  const imageData = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(imageMask.size - 1, Math.floor((x / size) * imageMask.size));
      const sy = Math.min(imageMask.size - 1, Math.floor((y / size) * imageMask.size));
      const value = imageMask.data[sy * imageMask.size + sx];
      const i = (y * size + x) * 4;
      imageData.data[i] = value ? 143 : 18;
      imageData.data[i + 1] = value ? 208 : 24;
      imageData.data[i + 2] = value ? 255 : 36;
      imageData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const blockW = size / params.projectionScale;
  const blockH = size / params.projectionScale;
  ctx.fillStyle = "rgba(255, 91, 91, 0.28)";
  ctx.fillRect((size - blockW) / 2, (size - blockH) / 2, blockW, blockH);
  ctx.strokeStyle = "rgba(255, 160, 160, 0.75)";
  ctx.lineWidth = 2;
  ctx.strokeRect((size - blockW) / 2, (size - blockH) / 2, blockW, blockH);
}

function drawMaskPreviews() {
  if (!projection) {
    return;
  }
  for (const face of FACE_KEYS) {
    const canvas = getCanvas(`${face}MaskCanvas`);
    const ctx = get2d(canvas);
    const imageData = ctx.createImageData(canvas.width, canvas.height);
    const source = projection.masks[face];
    const res = params.wallResolution;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const sx = Math.min(res - 1, Math.floor((x / canvas.width) * res));
        const sy = Math.min(res - 1, Math.floor((y / canvas.height) * res));
        const open = source[sy * res + sx];
        const i = (y * canvas.width + x) * 4;
        imageData.data[i] = open ? 143 : 21;
        imageData.data[i + 1] = open ? 208 : 25;
        imageData.data[i + 2] = open ? 255 : 35;
        imageData.data[i + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }
}

function updateStats() {
  if (!projection) {
    return;
  }
  const total = Math.max(1, projection.stats.targetPixels);
  const projected = Math.round((projection.stats.projectedPixels / total) * 100);
  const lost = Math.round(((projection.stats.blockedPixels + projection.stats.invalidPixels) / total) * 100);
  getElement("projectedStat").textContent = `${projected}%`;
  getElement("blockedStat").textContent = `${lost}%`;
  getElement("cellStat").textContent = `${getModelResolution(params.wallResolution)}²`;
  getElement("sourceStat").textContent = imageMask.label.length > 8 ? `${imageMask.label.slice(0, 8)}...` : imageMask.label;
  getElement("connectStat").textContent = projection.stats.isFullyConnected ? "是" : "否";
  getElement("floatingStat").textContent = String(projection.stats.floatingComponents);
}

function fitCamera() {
  if (!controls) {
    return;
  }
  const projectionSize = getProjectionSize(params);
  const maxProjection = Math.max(projectionSize.width, projectionSize.height);
  const boxMax = Math.max(params.boxWidth, params.boxHeight, params.boxDepth);
  const viewDistance = maxProjection * 1.25;
  camera.position.set(maxProjection * 0.18, -maxProjection * 0.1, viewDistance);
  controls.target.set(0, 0, 0);
  camera.lookAt(controls.target);
  camera.near = 0.1;
  camera.far = Math.max(boxMax, maxProjection) * 20;
  camera.updateProjectionMatrix();
}

function getProjectionSize(lamp: LampParams) {
  return {
    width: lamp.boxWidth * lamp.projectionScale,
    height: lamp.boxHeight * lamp.projectionScale,
  };
}

function resizeRenderer() {
  if (!renderer) {
    drawFallbackPreview();
    return;
  }
  const rect = viewer.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return;
  }
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(1, rect.height);
  camera.updateProjectionMatrix();
}

function animate() {
  if (!renderer || !controls) {
    return;
  }
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function exportStl() {
  const exportGroup = new THREE.Group();
  const source = modelGroup.getObjectByName("shadow-lamp-body");
  const back = modelGroup.getObjectByName("solid-back-plate");
  if (!source || !back) {
    return;
  }

  exportGroup.add(source.clone(true));
  exportGroup.add(back.clone(true));

  const lightPostHeight = getLightZ(params);
  const lightPostRadius = LAMP_POST_DIAMETER_MM * 0.5;
  const lightPost = new THREE.Mesh(
    new THREE.CylinderGeometry(lightPostRadius, lightPostRadius, lightPostHeight, 20),
    new THREE.MeshStandardMaterial(),
  );
  // CylinderGeometry 默认沿 Y 轴，旋转后沿 Z 轴作为灯柱。
  lightPost.rotation.x = Math.PI / 2;
  lightPost.position.set(0, 0, lightPostHeight / 2);
  exportGroup.add(lightPost);

  exportGroup.updateMatrixWorld(true);

  const exporter = new STLExporter();
  const stl = exporter.parse(exportGroup, { binary: false }) as string;
  const blob = new Blob([stl], { type: "model/stl" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "shadow-lamp-mvp.stl";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function removeSmallComponents(mask: Uint8Array, size: number, minArea: number) {
  const visited = new Uint8Array(size * size);
  const out = new Uint8Array(mask);
  const queue: number[] = [];

  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) {
      continue;
    }
    queue.length = 0;
    const component: number[] = [];
    visited[i] = 1;
    queue.push(i);

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      component.push(index);
      const x = index % size;
      const y = Math.floor(index / size);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) {
          continue;
        }
        const ni = ny * size + nx;
        if (mask[ni] && !visited[ni]) {
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }

    if (component.length < minArea) {
      for (const index of component) {
        out[index] = 0;
      }
    }
  }

  return out;
}

function smoothBinaryMask(mask: Uint8Array, size: number) {
  const closed = erodeBinaryMask(dilateBinaryMask(mask, size, 1), size, 1);
  const opened = dilateBinaryMask(erodeBinaryMask(closed, size, 1), size, 1);
  return majorityFilterBinaryMask(opened, size, 5);
}

function dilateBinaryMask(mask: Uint8Array, size: number, radius: number) {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let on = 0;
      for (let dy = -radius; dy <= radius && !on; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= size) continue;
          if (mask[ny * size + nx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * size + x] = on;
    }
  }
  return out;
}

function erodeBinaryMask(mask: Uint8Array, size: number, radius: number) {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let on = 1;
      for (let dy = -radius; dy <= radius && on; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) {
          on = 0;
          break;
        }
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= size || !mask[ny * size + nx]) {
            on = 0;
            break;
          }
        }
      }
      out[y * size + x] = on;
    }
  }
  return out;
}

function majorityFilterBinaryMask(mask: Uint8Array, size: number, threshold: number) {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= size) continue;
          count += mask[ny * size + nx];
        }
      }
      out[y * size + x] = count >= threshold ? 1 : 0;
    }
  }
  return out;
}

function overlapLength(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function invertMask(mask: Uint8Array) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    out[i] = mask[i] ? 0 : 1;
  }
  return out;
}

function getLightZ(lamp: LampParams) {
  return clamp(lamp.lightDistance, 3, lamp.boxDepth * 1.5);
}

function getModelResolution(wallResolution: number) {
  return Math.min(wallResolution, MODEL_RESOLUTION_CAP);
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getElement<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

function getInput(id: string) {
  return getElement<HTMLInputElement>(id);
}

function getCanvas(id: string) {
  return getElement<HTMLCanvasElement>(id);
}

function get2d(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D is unavailable");
  }
  return context;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material.dispose();
      }
    }
  });
}

function init3D() {
  try {
    renderer = createRendererWithFallback();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewer.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 28);

    const ambientLight = new THREE.AmbientLight("#dfe8ff", 0.38);
    scene.add(ambientLight);

    pointLight = new THREE.PointLight("#fff1b8", 9000, 600, 1.8);
    pointLight.castShadow = true;
    pointLight.shadow.mapSize.set(1024, 1024);
    scene.add(pointLight);

    const axesHelper = new THREE.AxesHelper(42);
    scene.add(axesHelper);

    fallbackCanvas?.remove();
    fallbackCanvas = null;
    setViewerMessage("");
    return true;
  } catch {
    fallbackCanvas = document.createElement("canvas");
    fallbackCanvas.className = "viewer-fallback-canvas";
    viewer.appendChild(fallbackCanvas);

    setViewerMessage("当前浏览器不支持 WebGL2，已切换 2D 预览。建议开启硬件加速，或使用强兼容 WebGL 启动器。");
    drawFallbackPreview();
    return false;
  }
}

function createRendererWithFallback() {
  const candidates = [
    { antialias: true, powerPreference: "high-performance" as const },
    { antialias: false, powerPreference: "high-performance" as const },
    { antialias: false, powerPreference: "default" as const },
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2", {
        alpha: false,
        antialias: candidate.antialias,
        depth: true,
        powerPreference: candidate.powerPreference,
      });
      if (!context) {
        lastError = new Error("WebGL2 context unavailable");
        continue;
      }
      return new THREE.WebGLRenderer({
        canvas,
        context,
        antialias: candidate.antialias,
        powerPreference: candidate.powerPreference,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("WebGLRenderer unavailable");
}

function setViewerMessage(message: string) {
  if (!message) {
    viewerMessage?.remove();
    viewerMessage = null;
    return;
  }

  if (!viewerMessage) {
    viewerMessage = document.createElement("div");
    viewerMessage.className = "viewer-message";
    viewer.appendChild(viewerMessage);
  }
  viewerMessage.textContent = message;
}

function drawFallbackPreview() {
  if (!fallbackCanvas) {
    return;
  }
  const rect = viewer.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (fallbackCanvas.width !== width || fallbackCanvas.height !== height) {
    fallbackCanvas.width = width;
    fallbackCanvas.height = height;
  }

  const ctx = get2d(fallbackCanvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0e1322";
  ctx.fillRect(0, 0, width, height);

  const padding = 28 * dpr;
  const projectionSize = getProjectionSize(params);
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(usableWidth / projectionSize.width, usableHeight / projectionSize.height);
  const wallWidth = projectionSize.width * scale;
  const wallHeight = projectionSize.height * scale;
  const wallX = (width - wallWidth) / 2;
  const wallY = (height - wallHeight) / 2;

  ctx.fillStyle = "#1b2435";
  ctx.fillRect(wallX, wallY, wallWidth, wallHeight);
  ctx.strokeStyle = "rgba(160, 192, 224, 0.45)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeRect(wallX, wallY, wallWidth, wallHeight);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(targetCanvas, wallX, wallY, wallWidth, wallHeight);
}

bindControls();
syncInputs();
resizeRenderer();
rebuildAll();
if (has3D) {
  animate();
}
requestAnimationFrame(() => {
  resizeRenderer();
  if (renderer) {
    renderer.render(scene, camera);
  }
});
