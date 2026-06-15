import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { createIcons, icons } from "lucide";
import {
  STEREO_CAMERA_FORWARD,
  STEREO_CAMERA_SCREEN_UP,
  boxFromFrames,
  fitCameraToBox,
  frameForward,
  framePosition,
  setStereoCameraNativeView,
} from "./cameraMath.js";
import { OcclusionProxy } from "./OcclusionProxy.js";
import "./styles.css";

const MANIFEST_URL = "/data/afternoon/manifest.json";
const FRAME_LAYER = 1;
const FPS_START_FRAME_INDEX = 0;
const GROUND_PLANE_NORMAL = new THREE.Vector3(0.00492588, -0.823496, 0.5673).normalize();
const FPS_MOVE_SPEED = 3.0;
const CAMERA_FRUSTUM_SCALE = 0.5;
const CAMERA_FRUSTUM_LINE_WIDTH = 2;
const CAMERA_OCCLUSION_RADIUS = 12;
const CAMERA_OCCLUDED_SAMPLE_THRESHOLD = 2;
const CAMERA_RAY_OCCLUSION_RADIUS = 0.04;
const CAMERA_RAY_OCCLUDED_SAMPLE_THRESHOLD = 1;
const CAMERA_MARKER_OCCLUSION_SHELL_RADIUS = 0.08;
const CAMERA_RAY_NEAR_PADDING = 0.08;
const CAMERA_RAY_TARGET_PADDING = 0.08;
const CAMERA_OCCLUSION_IDLE_INTERVAL_MS = 150;
const CAMERA_OCCLUSION_MOVING_INTERVAL_MS = 260;
const CAMERA_OCCLUSION_IDLE_BATCH_SIZE = 16;
const CAMERA_OCCLUSION_MOVING_BATCH_SIZE = 8;

const app = document.querySelector("#app");
app.innerHTML = `
  <main id="appShell" class="app-shell splat-primary">
    <section class="splat-stage" aria-label="3DGS maneuver view">
      <canvas id="splatCanvas" class="scene-canvas" tabindex="0"></canvas>
      <div class="toolbar splat-toolbar" aria-label="Splat navigation tools">
        <button id="fitSplat" class="icon-button" type="button" title="Reset FPS camera"><i data-lucide="locate-fixed"></i></button>
        <button class="icon-button swap-viewports" type="button" title="Swap render areas"><i data-lucide="replace"></i></button>
        <button id="toggleSplat" class="icon-button active" type="button" title="Toggle Gaussian splat"><i data-lucide="sparkles"></i></button>
        <button id="toggleCameras" class="icon-button active" type="button" title="Toggle camera icons"><i data-lucide="camera"></i></button>
        <button id="toggleOcclusion" class="icon-button active" type="button" title="Toggle marker occlusion"><i data-lucide="eye"></i></button>
        <button id="toggleFrustumSplat" class="icon-button" type="button" title="Toggle decorative frustum splat"><i data-lucide="aperture"></i></button>
      </div>
      <div class="viewport-label">3DGS Splat Area</div>
      <div id="splatStatus" class="mini-status">Loading 3DGS</div>
    </section>

    <aside id="rightRail" class="right-rail">
      <section class="cloud-stage" aria-label="Stereo point cloud view">
      <canvas id="cloudCanvas" class="scene-canvas"></canvas>
      <div class="toolbar cloud-toolbar" aria-label="Stereo point cloud tools">
        <button id="fitCloud" class="icon-button" type="button" title="Fit selected point cloud"><i data-lucide="maximize-2"></i></button>
        <button class="icon-button swap-viewports" type="button" title="Swap render areas"><i data-lucide="replace"></i></button>
        <button id="viewFromCamera" class="icon-button active" type="button" title="View from selected stereo camera"><i data-lucide="video"></i></button>
        <button id="toggleCloud" class="icon-button active" type="button" title="Toggle selected point cloud"><i data-lucide="cloud"></i></button>
      </div>
      <div class="viewport-label">Stereo PLY Area</div>
      <div class="status-bar">
        <div id="cloudStatus" class="status-pill">Select a camera in the splat area</div>
        <div class="metric-strip">
          <div><span>Cloud</span> <strong id="cloudMetric">none</strong></div>
          <div><span>Points</span> <strong id="pointMetric">0</strong></div>
        </div>
      </div>
    </section>

      <section class="side-panel" aria-label="Registered stereo cameras">
        <div class="panel-head">
          <div class="panel-title">
            <h1>Afternoon Cameras</h1>
            <span id="datasetTag">manifest</span>
          </div>
          <label class="search-row">
            <i data-lucide="search"></i>
            <input id="frameSearch" class="search-input" type="search" placeholder="Search timestamp" />
          </label>
        </div>
        <section id="selectedPanel" class="selected-panel" aria-label="Selected camera">
          <div class="selected-kicker">No camera selected</div>
          <div class="selected-name">Click a camera icon in the splat area.</div>
        </section>
        <div id="frameList" class="frame-list"></div>
      </section>
    </aside>
  </main>
`;
createIcons({ icons });

const appShell = document.querySelector("#appShell");
const rightRail = document.querySelector("#rightRail");
const cloudCanvas = document.querySelector("#cloudCanvas");
const splatCanvas = document.querySelector("#splatCanvas");
const cloudStage = document.querySelector(".cloud-stage");
const splatStage = document.querySelector(".splat-stage");
const sidePanel = document.querySelector(".side-panel");
const cloudStatus = document.querySelector("#cloudStatus");
const splatStatus = document.querySelector("#splatStatus");
const cloudMetric = document.querySelector("#cloudMetric");
const pointMetric = document.querySelector("#pointMetric");
const datasetTag = document.querySelector("#datasetTag");
const frameSearch = document.querySelector("#frameSearch");
const frameList = document.querySelector("#frameList");
const selectedPanel = document.querySelector("#selectedPanel");

const fitCloudButton = document.querySelector("#fitCloud");
const viewFromCameraButton = document.querySelector("#viewFromCamera");
const toggleCloudButton = document.querySelector("#toggleCloud");
const fitSplatButton = document.querySelector("#fitSplat");
const toggleSplatButton = document.querySelector("#toggleSplat");
const toggleCamerasButton = document.querySelector("#toggleCameras");
const toggleOcclusionButton = document.querySelector("#toggleOcclusion");
const toggleFrustumSplatButton = document.querySelector("#toggleFrustumSplat");
const swapViewportButtons = document.querySelectorAll(".swap-viewports");

const cloudRenderer = createRenderer(cloudCanvas, 0x121417);
const splatRenderer = createRenderer(splatCanvas, 0x111315);

const cloudScene = new THREE.Scene();
cloudScene.background = new THREE.Color(0x121417);
cloudScene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.25));

const splatScene = new THREE.Scene();
splatScene.background = new THREE.Color(0x111315);

const cloudCamera = new THREE.PerspectiveCamera(58, 1, 0.005, 1000);
cloudCamera.position.set(4, -4, 2.8);
cloudCamera.up.copy(STEREO_CAMERA_SCREEN_UP);
const splatCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 1000);
splatCamera.position.set(7, -7, 4);
splatCamera.layers.enable(FRAME_LAYER);
const occlusionCamera = new THREE.PerspectiveCamera();

const cloudControls = new OrbitControls(cloudCamera, cloudRenderer.domElement);
cloudControls.enableDamping = true;
cloudControls.dampingFactor = 0.08;
cloudControls.screenSpacePanning = true;

const splatFpsControls = createFpsControls(splatCamera, splatRenderer.domElement, {
  onDragChange: updateFpsDragUi,
});

const spark = new SparkRenderer({
  renderer: splatRenderer,
  focalAdjustment: 2.0,
  sortRadial: false,
  minSortIntervalMs: 32,
});
splatScene.add(spark);

const frameRoot = new THREE.Group();
frameRoot.name = "registered-camera-icons";
splatScene.add(frameRoot);

const plyLoader = new PLYLoader();
const occlusionProxy = new OcclusionProxy({ gridWidth: 320, gridHeight: 200, depthBias: 0.01, depthPointStride: 4 });
const splatSceneBox = new THREE.Box3();
const cloudSceneBox = new THREE.Box3();
const raycaster = new THREE.Raycaster();
raycaster.layers.enable(FRAME_LAYER);
const splatOcclusionRaycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const rayDirection = new THREE.Vector3();
const lineResolution = new THREE.Vector2();
const markerShellDirection = new THREE.Vector3();
const markerShellRight = new THREE.Vector3();
const markerShellUp = new THREE.Vector3();

let manifest = null;
let splatMesh = null;
let frustumSplatMesh = null;
let activeCloud = null;
let activeCloudGeometry = null;
let activeFrame = null;
let hoveredFrame = null;
let cloudLoadToken = 0;
let lastOcclusionUpdate = 0;
let lastOcclusionDepthDurationMs = 0;
let lastOcclusionBatchDurationMs = 0;
let lastAnimationTime = 0;
let visibleFrameCount = 0;
let occlusionPassActive = false;
let occlusionPassCursor = 0;
let occlusionPassObjects = [];

const frameObjects = new Map();
const frameRows = new Map();
const pickTargets = [];
const materials = createMaterials();

const state = {
  primaryViewport: "splat",
  fpsDragging: false,
  splatVisible: true,
  cloudVisible: true,
  camerasVisible: true,
  occlusionEnabled: true,
  frustumSplatVisible: false,
  stereoViewFromCamera: true,
};

function projectOntoGround(vector, normal) {
  const projected = vector.clone().addScaledVector(normal, -vector.dot(normal));
  if (projected.lengthSq() > 1e-10) projected.normalize();
  return projected;
}

function createFpsControls(camera, domElement, { groundNormal = GROUND_PLANE_NORMAL, onDragChange } = {}) {
  const up = groundNormal.clone().normalize();
  const groundForward = projectOntoGround(new THREE.Vector3(0, 1, 0), up);
  const groundRight = new THREE.Vector3().copy(groundForward).cross(up).normalize();
  const direction = new THREE.Vector3();
  const flatForward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  const keys = new Set();
  const target = new THREE.Vector3();
  const drag = {
    active: false,
    moved: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
  };

  const controls = {
    target,
    mouseSensitivity: 0.0018,
    moveSpeed: FPS_MOVE_SPEED,
    boostMultiplier: 3.2,
    slowMultiplier: 0.35,
    yaw: 0,
    pitch: 0,
    syncFromCamera,
    setPose,
    lookBy,
    beginDrag,
    dragLook,
    endDrag,
    cancelDrag,
    isDragging,
    isMoving,
    update,
    keyDown,
    keyUp,
    handlesKey,
    keys,
  };

  function syncFromCamera() {
    camera.getWorldDirection(direction);
    setAnglesFromDirection(direction);
    applyLook();
  }

  function setAnglesFromDirection(sourceDirection) {
    direction.copy(sourceDirection).normalize();
    controls.pitch = Math.asin(THREE.MathUtils.clamp(direction.dot(up), -0.995, 0.995));
    flatForward.copy(projectOntoGround(direction, up));
    if (flatForward.lengthSq() < 1e-6) {
      flatForward.copy(groundForward);
    } else {
      controls.yaw = Math.atan2(flatForward.dot(groundRight), flatForward.dot(groundForward));
    }
  }

  function applyLook() {
    const cp = Math.cos(controls.pitch);
    direction
      .copy(groundRight)
      .multiplyScalar(Math.sin(controls.yaw) * cp)
      .addScaledVector(groundForward, Math.cos(controls.yaw) * cp)
      .addScaledVector(up, Math.sin(controls.pitch))
      .normalize();
    target.copy(camera.position).add(direction);
    camera.up.copy(up);
    camera.lookAt(target);
  }

  function setPose(position, lookDirection) {
    camera.position.copy(position);
    setAnglesFromDirection(lookDirection);
    applyLook();
  }

  function lookBy(movementX, movementY) {
    controls.yaw += movementX * controls.mouseSensitivity;
    controls.pitch = THREE.MathUtils.clamp(controls.pitch - movementY * controls.mouseSensitivity, -1.42, 1.42);
    applyLook();
  }

  function movementVector() {
    camera.getWorldDirection(flatForward);
    flatForward.copy(projectOntoGround(flatForward, up));
    if (flatForward.lengthSq() < 1e-6) {
      flatForward
        .copy(groundRight)
        .multiplyScalar(Math.sin(controls.yaw))
        .addScaledVector(groundForward, Math.cos(controls.yaw));
    }
    flatForward.normalize();
    right.copy(flatForward).cross(up).normalize();
    move.set(0, 0, 0);
    if (keys.has("KeyW") || keys.has("ArrowUp")) move.add(flatForward);
    if (keys.has("KeyS") || keys.has("ArrowDown")) move.sub(flatForward);
    if (keys.has("KeyD") || keys.has("ArrowRight")) move.add(right);
    if (keys.has("KeyA") || keys.has("ArrowLeft")) move.sub(right);
    if (keys.has("KeyE") || keys.has("Space")) move.add(up);
    if (keys.has("KeyQ") || keys.has("ControlLeft") || keys.has("ControlRight")) move.sub(up);
    return move;
  }

  function update(deltaSeconds) {
    if (typeof deltaSeconds !== "number") {
      camera.up.copy(up);
      camera.lookAt(target);
      syncFromCamera();
      return;
    }
    const vector = movementVector();
    if (vector.lengthSq() > 0) {
      vector.normalize();
      const boost = keys.has("ShiftLeft") || keys.has("ShiftRight") ? controls.boostMultiplier : 1;
      const slow = keys.has("AltLeft") || keys.has("AltRight") ? controls.slowMultiplier : 1;
      camera.position.addScaledVector(vector, controls.moveSpeed * boost * slow * deltaSeconds);
    }
    applyLook();
  }

  function beginDrag(event) {
    domElement.focus();
    drag.active = true;
    drag.moved = false;
    drag.pointerId = event.pointerId;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    domElement.setPointerCapture?.(event.pointerId);
    onDragChange?.(true);
  }

  function dragLook(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) return false;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
    lookBy(dx, dy);
    return true;
  }

  function endDrag(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) return false;
    const wasClick = !drag.moved;
    releaseDrag();
    return wasClick;
  }

  function cancelDrag() {
    releaseDrag();
  }

  function releaseDrag() {
    if (drag.pointerId !== null) domElement.releasePointerCapture?.(drag.pointerId);
    drag.active = false;
    drag.pointerId = null;
    drag.moved = false;
    onDragChange?.(false);
  }

  function isDragging() {
    return drag.active;
  }

  function isMoving() {
    return (
      keys.has("KeyW") ||
      keys.has("KeyA") ||
      keys.has("KeyS") ||
      keys.has("KeyD") ||
      keys.has("ArrowUp") ||
      keys.has("ArrowDown") ||
      keys.has("ArrowLeft") ||
      keys.has("ArrowRight") ||
      keys.has("KeyQ") ||
      keys.has("KeyE") ||
      keys.has("Space") ||
      keys.has("ControlLeft") ||
      keys.has("ControlRight")
    );
  }

  function handlesKey(code) {
    return /^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|ControlLeft|ControlRight|ShiftLeft|ShiftRight|AltLeft|AltRight)$/.test(code);
  }

  function keyDown(event) {
    if (!handlesKey(event.code)) return;
    keys.add(event.code);
  }

  function keyUp(event) {
    keys.delete(event.code);
  }

  syncFromCamera();
  return controls;
}

function createRenderer(canvas, clearColor) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(clearColor, 1);
  return renderer;
}

function createPointSpriteTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.72, "rgba(255,255,255,1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function createMaterials() {
  const pointSprite = createPointSpriteTexture();
  const createLineMaterial = (color, opacity = 1) =>
    new LineMaterial({
      color,
      linewidth: CAMERA_FRUSTUM_LINE_WIDTH,
      transparent: true,
      opacity,
      depthTest: true,
      worldUnits: false,
    });

  return {
    line: createLineMaterial(0x4fc3a7, 0.9),
    lineHover: createLineMaterial(0xd8f2e7),
    lineActive: createLineMaterial(0xe5b75d),
    marker: new THREE.MeshBasicMaterial({ color: 0x4fc3a7, transparent: true, opacity: 0.94, depthTest: true }),
    markerHover: new THREE.MeshBasicMaterial({ color: 0xd8f2e7, transparent: true, opacity: 1, depthTest: true }),
    markerActive: new THREE.MeshBasicMaterial({ color: 0xe5b75d, transparent: true, opacity: 1, depthTest: true }),
    pick: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
    pointCloud: new THREE.PointsMaterial({
      size: 0.026,
      vertexColors: true,
      sizeAttenuation: true,
      map: pointSprite,
      alphaTest: 0.18,
      depthTest: true,
      depthWrite: true,
    }),
    pointCloudPlain: new THREE.PointsMaterial({
      size: 0.026,
      color: 0xe5d18b,
      sizeAttenuation: true,
      map: pointSprite,
      alphaTest: 0.18,
      depthTest: true,
      depthWrite: true,
    }),
  };
}

function setCloudStatus(message, strong = "") {
  cloudStatus.innerHTML = strong ? `<strong>${strong}</strong> ${message}` : message;
}

function setSplatStatus(message, strong = "") {
  splatStatus.innerHTML = strong ? `<strong>${strong}</strong> ${message}` : message;
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

function resizeRenderer(renderer, camera, canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function resizeRenderers() {
  resizeRenderer(cloudRenderer, cloudCamera, cloudCanvas);
  resizeRenderer(splatRenderer, splatCamera, splatCanvas);
  updateLineMaterialResolution();
}

function createFrameGeometry(frame) {
  const [origin, topLeft, topRight, bottomRight, bottomLeft] = scaledFramePoints(frame);
  const edgePositions = [
    ...origin.toArray(),
    ...topLeft.toArray(),
    ...origin.toArray(),
    ...topRight.toArray(),
    ...origin.toArray(),
    ...bottomRight.toArray(),
    ...origin.toArray(),
    ...bottomLeft.toArray(),
    ...topLeft.toArray(),
    ...topRight.toArray(),
    ...topRight.toArray(),
    ...bottomRight.toArray(),
    ...bottomRight.toArray(),
    ...bottomLeft.toArray(),
    ...bottomLeft.toArray(),
    ...topLeft.toArray(),
  ];
  return new LineSegmentsGeometry().setPositions(edgePositions);
}

function scaledFramePoints(frame) {
  const origin = framePosition(frame);
  return frame.frustum.map((point, index) => {
    const vertex = new THREE.Vector3().fromArray(point);
    return index === 0 ? origin.clone() : origin.clone().add(vertex.sub(origin).multiplyScalar(CAMERA_FRUSTUM_SCALE));
  });
}

function midpoint(a, b) {
  return new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
}

function averagePoints(points) {
  const average = new THREE.Vector3();
  for (const point of points) average.add(point);
  return average.multiplyScalar(1 / points.length);
}

function createFrameOcclusionSamples(frame) {
  const [origin, topLeft, topRight, bottomRight, bottomLeft] = scaledFramePoints(frame);
  const frameCenter = averagePoints([topLeft, topRight, bottomRight, bottomLeft]);

  return [
    origin,
    frameCenter,
    topLeft,
    topRight,
    bottomRight,
    bottomLeft,
    midpoint(origin, frameCenter),
    midpoint(origin, topLeft),
    midpoint(origin, topRight),
    midpoint(origin, bottomRight),
    midpoint(origin, bottomLeft),
    midpoint(topLeft, topRight),
    midpoint(topRight, bottomRight),
    midpoint(bottomRight, bottomLeft),
    midpoint(bottomLeft, topLeft),
  ];
}

function updateLineMaterialResolution() {
  splatRenderer.getDrawingBufferSize(lineResolution);
  for (const material of [materials.line, materials.lineHover, materials.lineActive]) {
    material.resolution.copy(lineResolution);
  }
}

function createFrameObject(frame) {
  const group = new THREE.Group();
  group.name = `camera-${frame.id}`;
  group.userData.frame = frame;

  const line = new LineSegments2(createFrameGeometry(frame), materials.line);
  line.layers.set(FRAME_LAYER);
  line.userData.frame = frame;
  group.add(line);

  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), materials.marker);
  marker.position.fromArray(frame.position);
  marker.layers.set(FRAME_LAYER);
  marker.userData.frame = frame;
  group.add(marker);

  const pick = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), materials.pick);
  pick.position.fromArray(frame.position);
  pick.layers.set(FRAME_LAYER);
  pick.userData.frame = frame;
  pickTargets.push(pick);
  group.add(pick);

  frameRoot.add(group);
  frameObjects.set(frame.id, { frame, group, line, marker, pick, occluded: false, occlusionSamples: createFrameOcclusionSamples(frame) });
}

function refreshFrameVisuals() {
  for (const frameObject of frameObjects.values()) {
    const isActive = activeFrame?.id === frameObject.frame.id;
    const isHovered = hoveredFrame?.id === frameObject.frame.id;
    frameObject.line.material = isActive ? materials.lineActive : isHovered ? materials.lineHover : materials.line;
    frameObject.marker.material = isActive ? materials.markerActive : isHovered ? materials.markerHover : materials.marker;
  }
}

function renderFrameList() {
  frameList.replaceChildren();
  frameRows.clear();
  for (const frame of manifest.frames) {
    const button = document.createElement("button");
    button.className = "frame-button";
    button.type = "button";
    button.dataset.frameId = frame.id;
    button.innerHTML = `
      <span class="frame-index">${frame.label}</span>
      <span class="frame-text">
        <span class="frame-id">${frame.id}</span>
        <span class="frame-sub">${formatNumber(frame.pointCount)} points</span>
      </span>
      <span class="frame-state"></span>
    `;
    button.addEventListener("mouseenter", () => {
      hoveredFrame = frame;
      refreshFrameVisuals();
    });
    button.addEventListener("mouseleave", () => {
      if (hoveredFrame?.id === frame.id) hoveredFrame = null;
      refreshFrameVisuals();
    });
    button.addEventListener("click", () => selectFrame(frame, { moveSplatCamera: false }));
    frameList.appendChild(button);
    frameRows.set(frame.id, button);
  }
}

function filterFrameList() {
  const query = frameSearch.value.trim().toLowerCase();
  for (const [frameId, row] of frameRows) {
    row.classList.toggle("hidden", query.length > 0 && !frameId.toLowerCase().includes(query));
  }
}

function updateSelectedPanel(frame) {
  if (!frame) {
    selectedPanel.innerHTML = `
      <div class="selected-kicker">No camera selected</div>
      <div class="selected-name">Click a camera icon in the splat area.</div>
    `;
    return;
  }
  selectedPanel.innerHTML = `
    ${frame.thumbnailUrl ? `<img src="${frame.thumbnailUrl}" alt="Frame ${frame.id}" />` : ""}
    <div class="selected-kicker">Camera ${frame.label}</div>
    <div class="selected-name">${frame.id}</div>
    <div class="selected-meta">
      <span>${formatNumber(frame.pointCount)} pts</span>
      <span>${frameObjects.get(frame.id)?.occluded ? "occluded" : "visible"}</span>
      <span>x ${frame.position[0].toFixed(2)}</span>
      <span>y ${frame.position[1].toFixed(2)}</span>
      <span>z ${frame.position[2].toFixed(2)}</span>
      <span>world</span>
    </div>
  `;
}

function updateFrameRows() {
  for (const [frameId, row] of frameRows) {
    const frameObject = frameObjects.get(frameId);
    row.classList.toggle("active", activeFrame?.id === frameId);
    row.classList.toggle("occluded", Boolean(frameObject?.occluded));
  }
}

function updateMetrics() {
  cloudMetric.textContent = activeFrame ? activeFrame.label : "none";
  pointMetric.textContent = activeFrame ? formatNumber(activeFrame.pointCount) : "0";
}

function applyVisibility() {
  if (splatMesh) splatMesh.visible = state.splatVisible;
  if (frustumSplatMesh) frustumSplatMesh.visible = state.frustumSplatVisible;
  if (activeCloud) activeCloud.visible = state.cloudVisible;
  frameRoot.visible = state.camerasVisible;

  toggleSplatButton.classList.toggle("active", state.splatVisible);
  toggleCloudButton.classList.toggle("active", state.cloudVisible);
  toggleCamerasButton.classList.toggle("active", state.camerasVisible);
  toggleOcclusionButton.classList.toggle("active", state.occlusionEnabled);
  toggleFrustumSplatButton.classList.toggle("active", state.frustumSplatVisible);
  toggleFrustumSplatButton.classList.toggle("warn", state.frustumSplatVisible);
  viewFromCameraButton.classList.toggle("active", state.stereoViewFromCamera);
}

function updateFpsDragUi(dragging) {
  state.fpsDragging = dragging;
  splatStage.classList.toggle("fps-dragging", dragging);
  if (dragging) {
    hoveredFrame = null;
    refreshFrameVisuals();
  }
}

function setPrimaryViewport(primaryViewport) {
  state.primaryViewport = primaryViewport;
  appShell.classList.toggle("splat-primary", primaryViewport === "splat");
  appShell.classList.toggle("cloud-primary", primaryViewport === "cloud");
  if (primaryViewport === "splat") {
    appShell.insertBefore(splatStage, rightRail);
    rightRail.insertBefore(cloudStage, sidePanel);
  } else {
    appShell.insertBefore(cloudStage, rightRail);
    rightRail.insertBefore(splatStage, sidePanel);
  }
  requestAnimationFrame(resizeRenderers);
}

function togglePrimaryViewport() {
  setPrimaryViewport(state.primaryViewport === "splat" ? "cloud" : "splat");
}

async function loadManifest() {
  const response = await fetch(MANIFEST_URL);
  if (!response.ok) throw new Error(`Failed to load manifest: ${response.status}`);
  manifest = await response.json();
  datasetTag.textContent = `${manifest.frames.length} frames`;
  splatSceneBox.copy(boxFromFrames(manifest.frames));
}

async function loadSplatScene() {
  setSplatStatus("Loading Gaussian splat", "3DGS");
  splatMesh = new SplatMesh({
    url: manifest.assets.splatUrl,
    raycastable: true,
    minRaycastOpacity: 0.08,
    onProgress: (event) => {
      if (event.total) {
        setSplatStatus(`${Math.round((event.loaded / event.total) * 100)}%`, "Loading splat");
      }
    },
  });
  splatScene.add(splatMesh);
  await splatMesh.initialized;

  frustumSplatMesh = new SplatMesh({ url: manifest.assets.frustumSplatUrl });
  frustumSplatMesh.visible = false;
  frustumSplatMesh.opacity = 0.65;
  splatScene.add(frustumSplatMesh);
  setSplatStatus("Click camera icons to load stereo clouds.", "3DGS ready");
}

async function loadOcclusionProxy() {
  await occlusionProxy.load(manifest.assets.occlusionProxyUrl);
}

function loadPointCloud(frame) {
  const token = ++cloudLoadToken;
  setCloudStatus(`Loading point cloud`, `Camera ${frame.label}`);
  plyLoader.load(
    frame.cloudUrl,
    (geometry) => {
      if (token !== cloudLoadToken) {
        geometry.dispose();
        return;
      }
      disposeActiveCloud();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      cloudSceneBox.copy(geometry.boundingBox ?? new THREE.Box3());
      const hasColor = geometry.hasAttribute("color");
      activeCloudGeometry = geometry;
      activeCloud = new THREE.Points(geometry, hasColor ? materials.pointCloud : materials.pointCloudPlain);
      activeCloud.name = `cloud-${frame.id}`;
      activeCloud.visible = state.cloudVisible;
      cloudScene.add(activeCloud);

      if (state.stereoViewFromCamera) {
        setStereoCameraNativeView(cloudCamera, cloudControls, cloudSceneBox);
      } else {
        fitCloud();
      }
      setCloudStatus(`${formatNumber(geometry.getAttribute("position").count)} points loaded`, `Camera ${frame.label}`);
    },
    (event) => {
      if (event.total && token === cloudLoadToken) {
        setCloudStatus(`${Math.round((event.loaded / event.total) * 100)}%`, `Loading ${frame.label}`);
      }
    },
    (error) => {
      if (token !== cloudLoadToken) return;
      console.error(error);
      setCloudStatus("Point cloud failed to load", frame.id);
    },
  );
}

function disposeActiveCloud() {
  if (activeCloud) {
    cloudScene.remove(activeCloud);
    activeCloud = null;
  }
  if (activeCloudGeometry) {
    activeCloudGeometry.dispose();
    activeCloudGeometry = null;
  }
}

function selectFrame(frame, { moveSplatCamera = false } = {}) {
  activeFrame = frame;
  if (moveSplatCamera) {
    splatFpsControls.setPose(framePosition(frame), frameForward(frame));
  }
  loadPointCloud(frame);
  updateSelectedPanel(frame);
  updateFrameRows();
  refreshFrameVisuals();
  updateMetrics();
  frameRows.get(frame.id)?.scrollIntoView({ block: "nearest" });
}

function fitSplat() {
  resetSplatFpsView();
}

function resetSplatFpsView(frame = activeFrame ?? manifest?.frames?.[FPS_START_FRAME_INDEX]) {
  if (!frame) {
    fitCameraToBox(splatCamera, splatFpsControls, splatSceneBox);
    return;
  }
  splatFpsControls.setPose(framePosition(frame), frameForward(frame));
  splatCamera.near = 0.01;
  splatCamera.far = 1000;
  splatCamera.updateProjectionMatrix();
}

function fitCloud() {
  if (cloudSceneBox.isEmpty()) {
    setCloudStatus("No cloud loaded yet");
    return;
  }
  cloudCamera.up.copy(STEREO_CAMERA_SCREEN_UP);
  fitCameraToBox(cloudCamera, cloudControls, cloudSceneBox, new THREE.Vector3(0.55, -0.55, -0.75));
}

function viewStereoFromSelectedCamera() {
  if (!activeFrame) {
    setCloudStatus("No selected camera yet");
    return;
  }
  setStereoCameraNativeView(cloudCamera, cloudControls, cloudSceneBox);
}

function setPointerFromEvent(event) {
  const rect = splatRenderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
}

function pickFrame(event) {
  setPointerFromEvent(event);
  return pickFrameFromPointer();
}

function pickFrameFromPointer() {
  if (!state.camerasVisible) return null;
  raycaster.setFromCamera(pointer, splatCamera);
  const intersects = raycaster.intersectObjects(pickTargets, false);
  for (const intersect of intersects) {
    const frame = intersect.object.userData.frame;
    const frameObject = frameObjects.get(frame.id);
    if (frameObject && !frameObject.occluded && frameObject.group.visible) return frame;
  }
  return null;
}

function openFrameFromSplat(frame) {
  if (!frame) return false;
  if (isFrameBlockedBySplat(frame)) {
    setSplatStatus("Camera is hidden from this splat view. Select it from the list or move to a clear line of sight.", `Camera ${frame.label}`);
    return false;
  }
  selectFrame(frame, { moveSplatCamera: false });
  return true;
}

function isFrameBlockedBySplat(frame) {
  if (!state.occlusionEnabled || !splatMesh) return false;
  const frameObject = frameObjects.get(frame.id);
  if (frameObject?.occluded || (frameObject && isFrameProxyOccluded(frameObject))) return true;

  const target = framePosition(frame);
  const distance = splatCamera.position.distanceTo(target);
  if (distance < 0.08) return false;
  rayDirection.copy(target).sub(splatCamera.position).normalize();
  splatOcclusionRaycaster.set(splatCamera.position, rayDirection);
  splatOcclusionRaycaster.near = splatCamera.near;
  splatOcclusionRaycaster.far = Math.max(0.01, distance - 0.08);
  const hits = [];
  splatMesh.raycast(splatOcclusionRaycaster, hits);
  return hits.length > 0;
}

function markerOcclusionTargets(frameOrigin, camera = splatCamera) {
  markerShellDirection.copy(frameOrigin).sub(camera.position);
  const distance = markerShellDirection.length();
  if (distance < 1e-5) return [frameOrigin];

  markerShellDirection.multiplyScalar(1 / distance);
  markerShellRight.crossVectors(markerShellDirection, camera.up);
  if (markerShellRight.lengthSq() < 1e-6) {
    markerShellRight.setFromMatrixColumn(camera.matrixWorld, 0);
  }
  markerShellRight.normalize();
  markerShellUp.crossVectors(markerShellRight, markerShellDirection).normalize();

  const radius = Math.min(0.16, Math.max(CAMERA_MARKER_OCCLUSION_SHELL_RADIUS, distance * 0.006));
  return [
    frameOrigin,
    frameOrigin.clone().addScaledVector(markerShellRight, radius),
    frameOrigin.clone().addScaledVector(markerShellRight, -radius),
    frameOrigin.clone().addScaledVector(markerShellUp, radius),
    frameOrigin.clone().addScaledVector(markerShellUp, -radius),
  ];
}

function isFrameProxyOccluded(frameObject, camera = splatCamera) {
  if (!occlusionProxy.count) return false;
  if (occlusionProxy.isOccluded(frameObject.occlusionSamples[0], camera, CAMERA_OCCLUSION_RADIUS)) {
    return true;
  }

  let sampleOcclusionCount = 0;
  for (let index = 1; index < frameObject.occlusionSamples.length; index += 1) {
    const occluded = occlusionProxy.isOccluded(frameObject.occlusionSamples[index], camera, CAMERA_OCCLUSION_RADIUS);
    if (!occluded) continue;
    sampleOcclusionCount += 1;
    if (sampleOcclusionCount >= CAMERA_OCCLUDED_SAMPLE_THRESHOLD) return true;
  }

  const rayHits = occlusionProxy.countOccludedRays(
    camera.position,
    markerOcclusionTargets(frameObject.occlusionSamples[0], camera),
    CAMERA_RAY_OCCLUSION_RADIUS,
    CAMERA_RAY_NEAR_PADDING,
    CAMERA_RAY_TARGET_PADDING,
    CAMERA_RAY_OCCLUDED_SAMPLE_THRESHOLD,
  );
  if (rayHits >= CAMERA_RAY_OCCLUDED_SAMPLE_THRESHOLD) {
    return true;
  }

  return false;
}

function handleSplatPointerMove(event) {
  if (splatFpsControls.dragLook(event)) {
    return;
  }
  const nextHover = pickFrame(event);
  if (nextHover?.id !== hoveredFrame?.id) {
    hoveredFrame = nextHover;
    splatRenderer.domElement.style.cursor = hoveredFrame ? "pointer" : "crosshair";
    refreshFrameVisuals();
  }
}

function handleSplatPointerDown(event) {
  if (event.button !== 0) return;
  splatFpsControls.beginDrag(event);
}

function handleSplatPointerUp(event) {
  if (event.button !== 0) return;
  const wasClick = splatFpsControls.endDrag(event);
  if (!wasClick) return;
  const frame = pickFrame(event);
  if (frame) {
    openFrameFromSplat(frame);
  }
}

function updateOcclusion(now) {
  if (!state.camerasVisible || !manifest) return;
  if (!state.occlusionEnabled) {
    occlusionPassActive = false;
    lastOcclusionDepthDurationMs = 0;
    lastOcclusionBatchDurationMs = 0;
    visibleFrameCount = manifest.frames.length;
    for (const frameObject of frameObjects.values()) {
      frameObject.occluded = false;
      frameObject.group.visible = true;
      frameObject.pick.visible = true;
    }
    updateFrameRows();
    return;
  }
  const updateInterval = splatFpsControls.isMoving() || splatFpsControls.isDragging() ? CAMERA_OCCLUSION_MOVING_INTERVAL_MS : CAMERA_OCCLUSION_IDLE_INTERVAL_MS;
  if (!occlusionPassActive && now - lastOcclusionUpdate >= updateInterval) {
    beginOcclusionPass(now);
  }
  if (occlusionPassActive) {
    processOcclusionBatch();
  }
}

function beginOcclusionPass(now) {
  lastOcclusionUpdate = now;
  const start = performance.now();
  occlusionCamera.copy(splatCamera, false);
  occlusionCamera.updateMatrixWorld(true);
  occlusionCamera.updateProjectionMatrix();
  if (occlusionProxy.count) occlusionProxy.update(occlusionCamera, now);
  lastOcclusionDepthDurationMs = performance.now() - start;
  occlusionPassObjects = Array.from(frameObjects.values());
  occlusionPassCursor = 0;
  occlusionPassActive = true;
}

function processOcclusionBatch() {
  const start = performance.now();
  const batchSize = splatFpsControls.isMoving() || splatFpsControls.isDragging() ? CAMERA_OCCLUSION_MOVING_BATCH_SIZE : CAMERA_OCCLUSION_IDLE_BATCH_SIZE;
  const end = Math.min(occlusionPassObjects.length, occlusionPassCursor + batchSize);

  for (; occlusionPassCursor < end; occlusionPassCursor += 1) {
    const frameObject = occlusionPassObjects[occlusionPassCursor];
    const occluded = isFrameProxyOccluded(frameObject, occlusionCamera);
    frameObject.occluded = occluded;
    frameObject.group.visible = !occluded;
    frameObject.pick.visible = !occluded;
  }

  visibleFrameCount = 0;
  for (const frameObject of frameObjects.values()) {
    if (!frameObject.occluded) visibleFrameCount += 1;
  }

  updateFrameRows();
  if (activeFrame) updateSelectedPanel(activeFrame);
  lastOcclusionBatchDurationMs = performance.now() - start;
  if (occlusionPassCursor >= occlusionPassObjects.length) {
    occlusionPassActive = false;
  }
}

function animate(now) {
  const deltaSeconds = Math.min(0.05, Math.max(0.001, (now - lastAnimationTime) / 1000 || 0.016));
  lastAnimationTime = now;
  splatFpsControls.update(deltaSeconds);
  cloudControls.update();
  updateOcclusion(now);
  splatRenderer.render(splatScene, splatCamera);
  cloudRenderer.render(cloudScene, cloudCamera);
}

function bindEvents() {
  window.addEventListener("resize", resizeRenderers);
  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.code === "Escape" && splatFpsControls.isDragging()) {
      splatFpsControls.cancelDrag();
      return;
    }
    const splatKeyboardActive = document.activeElement === splatRenderer.domElement;
    if (splatKeyboardActive && splatFpsControls.handlesKey(event.code)) {
      event.preventDefault();
      splatFpsControls.keyDown(event);
    }
  });
  window.addEventListener("keyup", (event) => splatFpsControls.keyUp(event));
  frameSearch.addEventListener("input", filterFrameList);
  swapViewportButtons.forEach((button) => button.addEventListener("click", togglePrimaryViewport));

  splatRenderer.domElement.addEventListener("pointermove", handleSplatPointerMove);
  splatRenderer.domElement.addEventListener("pointerdown", handleSplatPointerDown);
  splatRenderer.domElement.addEventListener("pointerup", handleSplatPointerUp);
  splatRenderer.domElement.addEventListener("pointerleave", () => {
    splatFpsControls.cancelDrag();
    splatRenderer.domElement.style.cursor = "crosshair";
    hoveredFrame = null;
    refreshFrameVisuals();
  });

  fitSplatButton.addEventListener("click", fitSplat);
  fitCloudButton.addEventListener("click", fitCloud);
  viewFromCameraButton.addEventListener("click", () => {
    state.stereoViewFromCamera = !state.stereoViewFromCamera;
    applyVisibility();
    if (state.stereoViewFromCamera) viewStereoFromSelectedCamera();
  });
  toggleSplatButton.addEventListener("click", () => {
    state.splatVisible = !state.splatVisible;
    applyVisibility();
  });
  toggleCloudButton.addEventListener("click", () => {
    state.cloudVisible = !state.cloudVisible;
    applyVisibility();
  });
  toggleCamerasButton.addEventListener("click", () => {
    state.camerasVisible = !state.camerasVisible;
    applyVisibility();
  });
  toggleOcclusionButton.addEventListener("click", () => {
    state.occlusionEnabled = !state.occlusionEnabled;
    lastOcclusionUpdate = 0;
    applyVisibility();
  });
  toggleFrustumSplatButton.addEventListener("click", () => {
    state.frustumSplatVisible = !state.frustumSplatVisible;
    applyVisibility();
  });
}

async function init() {
  try {
    bindEvents();
    resizeRenderers();
    setCloudStatus("Select a camera in the splat area");
    setSplatStatus("Loading manifest");
    await loadManifest();
    for (const frame of manifest.frames) createFrameObject(frame);
    renderFrameList();
    updateMetrics();
    applyVisibility();

    await Promise.all([loadOcclusionProxy(), loadSplatScene()]);
    fitSplat();
    updateSelectedPanel(null);
    updateFrameRows();
    cloudControls.target.copy(STEREO_CAMERA_FORWARD);
    cloudControls.update();
    splatRenderer.setAnimationLoop(animate);
  } catch (error) {
    console.error(error);
    setCloudStatus(error instanceof Error ? error.message : String(error), "Startup failed");
    setSplatStatus("Startup failed");
  }
}

window.afternoonViewer = {
  getState() {
    return {
      primaryViewport: state.primaryViewport,
      fpsDragging: state.fpsDragging,
      activeFrame: activeFrame?.id ?? null,
      activeCloudUrl: activeFrame?.cloudUrl ?? null,
      activeCloudCoordinateFrame: activeFrame?.cloudCoordinateFrame ?? null,
      splatCameraPosition: splatCamera.position.toArray(),
      splatCameraDirection: splatCamera.getWorldDirection(new THREE.Vector3()).toArray(),
      splatFpsYaw: splatFpsControls.yaw,
      splatFpsPitch: splatFpsControls.pitch,
      groundNormal: GROUND_PLANE_NORMAL.toArray(),
      movementSpeed: FPS_MOVE_SPEED,
      frustumScale: CAMERA_FRUSTUM_SCALE,
      frustumLineWidth: CAMERA_FRUSTUM_LINE_WIDTH,
      occlusionPolicy: {
        depthRadius: CAMERA_OCCLUSION_RADIUS,
        depthSampleThreshold: CAMERA_OCCLUDED_SAMPLE_THRESHOLD,
        rayRadius: CAMERA_RAY_OCCLUSION_RADIUS,
        raySampleThreshold: CAMERA_RAY_OCCLUDED_SAMPLE_THRESHOLD,
        markerShellRadius: CAMERA_MARKER_OCCLUSION_SHELL_RADIUS,
        idleIntervalMs: CAMERA_OCCLUSION_IDLE_INTERVAL_MS,
        movingIntervalMs: CAMERA_OCCLUSION_MOVING_INTERVAL_MS,
        idleBatchSize: CAMERA_OCCLUSION_IDLE_BATCH_SIZE,
        movingBatchSize: CAMERA_OCCLUSION_MOVING_BATCH_SIZE,
      },
      occlusionProxyCells: occlusionProxy.spatialCells?.size ?? 0,
      occlusionDepthPointStride: occlusionProxy.depthPointStride,
      occlusionPassActive,
      lastOcclusionDepthDurationMs,
      lastOcclusionBatchDurationMs,
      lastOcclusionDurationMs: lastOcclusionDepthDurationMs + lastOcclusionBatchDurationMs,
      visibleFrameCount,
      cloudCameraPosition: cloudCamera.position.toArray(),
      cloudCameraDirection: cloudCamera.getWorldDirection(new THREE.Vector3()).toArray(),
      cloudCameraUp: cloudCamera.up.toArray(),
      stereoCloudAxes: {
        x: "+X image right",
        y: "+Y image down",
        z: "+Z sensor to scene",
      },
      cloudStatus: cloudStatus.textContent,
      splatStatus: splatStatus.textContent,
    };
  },
};

init();
