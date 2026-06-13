import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { createIcons, icons } from "lucide";
import { boxFromFrames, fitCameraToBox, framePosition, setCameraToFrame } from "./cameraMath.js";
import { OcclusionProxy } from "./OcclusionProxy.js";
import "./styles.css";

const MANIFEST_URL = "/data/afternoon/manifest.json";
const FRAME_LAYER = 1;

const app = document.querySelector("#app");
app.innerHTML = `
  <main class="app-shell">
    <section class="cloud-stage" aria-label="Stereo point cloud view">
      <canvas id="cloudCanvas" class="scene-canvas"></canvas>
      <div class="toolbar cloud-toolbar" aria-label="Stereo point cloud tools">
        <button id="fitCloud" class="icon-button" type="button" title="Fit selected point cloud"><i data-lucide="maximize-2"></i></button>
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

    <aside class="right-rail">
      <section class="splat-stage" aria-label="3DGS maneuver view">
        <canvas id="splatCanvas" class="scene-canvas"></canvas>
        <div class="toolbar splat-toolbar" aria-label="Splat navigation tools">
          <button id="fitSplat" class="icon-button" type="button" title="Fit splat view"><i data-lucide="maximize-2"></i></button>
          <button id="toggleSplat" class="icon-button active" type="button" title="Toggle Gaussian splat"><i data-lucide="sparkles"></i></button>
          <button id="toggleCameras" class="icon-button active" type="button" title="Toggle camera icons"><i data-lucide="camera"></i></button>
          <button id="toggleOcclusion" class="icon-button active" type="button" title="Toggle marker occlusion"><i data-lucide="eye"></i></button>
          <button id="toggleFrustumSplat" class="icon-button" type="button" title="Toggle decorative frustum splat"><i data-lucide="aperture"></i></button>
        </div>
        <div class="viewport-label">3DGS Splat Area</div>
        <div id="splatStatus" class="mini-status">Loading 3DGS</div>
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

const cloudCanvas = document.querySelector("#cloudCanvas");
const splatCanvas = document.querySelector("#splatCanvas");
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

const cloudRenderer = createRenderer(cloudCanvas, 0x121417);
const splatRenderer = createRenderer(splatCanvas, 0x111315);

const cloudScene = new THREE.Scene();
cloudScene.background = new THREE.Color(0x121417);
cloudScene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.25));

const splatScene = new THREE.Scene();
splatScene.background = new THREE.Color(0x111315);

const cloudCamera = new THREE.PerspectiveCamera(58, 1, 0.005, 1000);
cloudCamera.position.set(4, -4, 2.8);
const splatCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 1000);
splatCamera.position.set(7, -7, 4);
splatCamera.layers.enable(FRAME_LAYER);

const cloudControls = new OrbitControls(cloudCamera, cloudRenderer.domElement);
cloudControls.enableDamping = true;
cloudControls.dampingFactor = 0.08;
cloudControls.screenSpacePanning = true;

const splatControls = new OrbitControls(splatCamera, splatRenderer.domElement);
splatControls.enableDamping = true;
splatControls.dampingFactor = 0.08;
splatControls.screenSpacePanning = true;

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
const occlusionProxy = new OcclusionProxy();
const splatSceneBox = new THREE.Box3();
const cloudSceneBox = new THREE.Box3();
const raycaster = new THREE.Raycaster();
raycaster.layers.enable(FRAME_LAYER);
const splatOcclusionRaycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const worldPosition = new THREE.Vector3();
const rayDirection = new THREE.Vector3();

let manifest = null;
let splatMesh = null;
let frustumSplatMesh = null;
let activeCloud = null;
let activeCloudGeometry = null;
let activeFrame = null;
let hoveredFrame = null;
let cloudLoadToken = 0;
let lastOcclusionUpdate = 0;
let visibleFrameCount = 0;

const frameObjects = new Map();
const frameRows = new Map();
const pickTargets = [];
const materials = createMaterials();

const state = {
  splatVisible: true,
  cloudVisible: true,
  camerasVisible: true,
  occlusionEnabled: true,
  frustumSplatVisible: false,
  stereoViewFromCamera: true,
};

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

function createMaterials() {
  return {
    line: new THREE.LineBasicMaterial({ color: 0x4fc3a7, transparent: true, opacity: 0.9, depthTest: true }),
    lineHover: new THREE.LineBasicMaterial({ color: 0xd8f2e7, transparent: true, opacity: 1, depthTest: true }),
    lineActive: new THREE.LineBasicMaterial({ color: 0xe5b75d, transparent: true, opacity: 1, depthTest: true }),
    marker: new THREE.MeshBasicMaterial({ color: 0x4fc3a7, transparent: true, opacity: 0.94, depthTest: true }),
    markerHover: new THREE.MeshBasicMaterial({ color: 0xd8f2e7, transparent: true, opacity: 1, depthTest: true }),
    markerActive: new THREE.MeshBasicMaterial({ color: 0xe5b75d, transparent: true, opacity: 1, depthTest: true }),
    pick: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
    pointCloud: new THREE.PointsMaterial({ size: 0.018, vertexColors: true, sizeAttenuation: true, depthTest: true }),
    pointCloudPlain: new THREE.PointsMaterial({ size: 0.018, color: 0xe5d18b, sizeAttenuation: true, depthTest: true }),
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
}

function createFrameGeometry(frame) {
  const [origin, topLeft, topRight, bottomRight, bottomLeft] = frame.frustum.map((point) => new THREE.Vector3().fromArray(point));
  const edgePoints = [
    origin,
    topLeft,
    origin,
    topRight,
    origin,
    bottomRight,
    origin,
    bottomLeft,
    topLeft,
    topRight,
    topRight,
    bottomRight,
    bottomRight,
    bottomLeft,
    bottomLeft,
    topLeft,
  ];
  return new THREE.BufferGeometry().setFromPoints(edgePoints);
}

function createFrameObject(frame) {
  const group = new THREE.Group();
  group.name = `camera-${frame.id}`;
  group.userData.frame = frame;

  const line = new THREE.LineSegments(createFrameGeometry(frame), materials.line);
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
  frameObjects.set(frame.id, { frame, group, line, marker, pick, occluded: false });
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
        setCameraToFrame(cloudCamera, cloudControls, frame);
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
    splatControls.target.copy(framePosition(frame));
    splatControls.update();
  }
  loadPointCloud(frame);
  updateSelectedPanel(frame);
  updateFrameRows();
  refreshFrameVisuals();
  updateMetrics();
  frameRows.get(frame.id)?.scrollIntoView({ block: "nearest" });
}

function fitSplat() {
  fitCameraToBox(splatCamera, splatControls, splatSceneBox);
}

function fitCloud() {
  if (cloudSceneBox.isEmpty()) {
    setCloudStatus("No cloud loaded yet");
    return;
  }
  fitCameraToBox(cloudCamera, cloudControls, cloudSceneBox, new THREE.Vector3(0.55, -0.85, 0.5));
}

function viewStereoFromSelectedCamera() {
  if (!activeFrame) {
    setCloudStatus("No selected camera yet");
    return;
  }
  setCameraToFrame(cloudCamera, cloudControls, activeFrame);
}

function setPointerFromEvent(event) {
  const rect = splatRenderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
}

function pickFrame(event) {
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointer, splatCamera);
  const intersects = raycaster.intersectObjects(pickTargets, false);
  return intersects[0]?.object.userData.frame ?? null;
}

function isFrameBlockedBySplat(frame) {
  if (!state.occlusionEnabled || !splatMesh) return false;
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

function handleSplatPointerMove(event) {
  const nextHover = pickFrame(event);
  if (nextHover?.id !== hoveredFrame?.id) {
    hoveredFrame = nextHover;
    splatRenderer.domElement.style.cursor = hoveredFrame ? "pointer" : "grab";
    refreshFrameVisuals();
  }
}

function handleSplatPointerDown() {
  splatRenderer.domElement.style.cursor = "grabbing";
}

function handleSplatPointerUp(event) {
  splatRenderer.domElement.style.cursor = hoveredFrame ? "pointer" : "grab";
  const frame = pickFrame(event);
  if (!frame) return;
  if (isFrameBlockedBySplat(frame)) {
    setSplatStatus("Camera is hidden from this splat view. Orbit for a clear line of sight or select it from the list.", `Camera ${frame.label}`);
    return;
  }
  selectFrame(frame, { moveSplatCamera: false });
}

function updateOcclusion(now) {
  if (!state.camerasVisible || !manifest) return;
  if (!state.occlusionEnabled || !occlusionProxy.count) {
    visibleFrameCount = manifest.frames.length;
    for (const frameObject of frameObjects.values()) {
      frameObject.occluded = false;
      frameObject.group.visible = true;
    }
    updateFrameRows();
    return;
  }
  if (now - lastOcclusionUpdate < 150) return;
  lastOcclusionUpdate = now;
  occlusionProxy.update(splatCamera, now);
  visibleFrameCount = 0;

  for (const frameObject of frameObjects.values()) {
    worldPosition.copy(framePosition(frameObject.frame));
    const occluded = occlusionProxy.isOccluded(worldPosition, splatCamera, 3);
    frameObject.occluded = occluded;
    frameObject.group.visible = !occluded;
    if (!occluded) visibleFrameCount += 1;
  }
  updateFrameRows();
  if (activeFrame) updateSelectedPanel(activeFrame);
}

function animate(now) {
  splatControls.update();
  cloudControls.update();
  updateOcclusion(now);
  splatRenderer.render(splatScene, splatCamera);
  cloudRenderer.render(cloudScene, cloudCamera);
}

function bindEvents() {
  window.addEventListener("resize", resizeRenderers);
  frameSearch.addEventListener("input", filterFrameList);

  splatRenderer.domElement.addEventListener("pointermove", handleSplatPointerMove);
  splatRenderer.domElement.addEventListener("pointerdown", handleSplatPointerDown);
  splatRenderer.domElement.addEventListener("pointerup", handleSplatPointerUp);
  splatRenderer.domElement.addEventListener("pointerleave", () => {
    splatRenderer.domElement.style.cursor = "grab";
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
    cloudControls.target.set(0, 0, 0);
    cloudControls.update();
    splatRenderer.setAnimationLoop(animate);
  } catch (error) {
    console.error(error);
    setCloudStatus(error instanceof Error ? error.message : String(error), "Startup failed");
    setSplatStatus("Startup failed");
  }
}

init();
