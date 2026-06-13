# Afternoon 3DGS Camera Viewer

Spark/Three.js rewrite of the original 3DGS point-cloud viewer.

The app has two coordinated Three.js render areas:

- The 3DGS splat area renders the trained Gaussian splat and clickable registered stereo camera icons.
- The stereo PLY area renders the currently selected camera's world-aligned point cloud.

Clicking a camera icon in the splat area swaps the point cloud shown in the stereo PLY area.

## Run

```bash
npm install
npm run build:data
npm run dev
```

`build:data` uses `uv run --with numpy` so NumPy is available without relying on a global Python install.

## Controls

- Orbit/zoom/pan independently in the stereo PLY area and the 3DGS splat area.
- Click a camera icon/frustum in the splat area, or click a timestamp row, to load that frame's point cloud in the stereo PLY area.
- By default, the stereo PLY camera is moved to the selected registered capture angle after the cloud loads.
- Toolbar buttons toggle fit view, view-from-camera mode, splat visibility, selected cloud visibility, camera frustums, occlusion checks, and the decorative frustum splat layer.
- The right panel provides timestamp search, selected-frame metadata, thumbnail preview, and point count.

Open the Vite URL, usually:

```text
http://127.0.0.1:5173/
```

## Data Inputs

Defaults used by `npm run build:data`:

```text
/Users/andyliu/Downloads/afternoon_data/AFTERNOON_ONLY.ply
/Users/andyliu/Downloads/afternoon_data/stereo_camera_frustums.ply
/Users/andyliu/Downloads/afternoon_data/stereo_camera_poses.json
/Users/andyliu/Downloads/20260612_littlehouse_stereo/<timestamp>/cloud.ply
```

The generated web assets live under:

```text
public/data/afternoon/
```

Large splat/cloud files are intentionally ignored by Git. The manifest is small and remains tracked.

## Design

- Spark renders `AFTERNOON_ONLY.ply` in the splat area only.
- The stereo PLY area is a separate Three.js renderer/scene that displays one selected downsampled point cloud at a time.
- Camera markers are generated from `stereo_camera_poses.json`, not from the decorative frustum splat PLY.
- The dataset builder transforms each stereo cloud from camera coordinates to 3DGS world coordinates using `quaternion_wxyz_c2w` and `position`.
- Point clouds are downsampled before browser use. The raw `cloud.ply` files are too large for smooth click-to-load interaction.
- Marker visibility uses a downsampled proxy sampled from the 3DGS splat centers so cameras hidden behind walls can be suppressed instead of floating through the scene as HTML overlays.
- Canvas clicks also run a Spark splat raycast guard before opening a camera, so a camera blocked by the splat scene is not accidentally selected from behind a wall.

## Verification

```bash
npm test
```

This validates generated manifest asset paths and builds the production bundle.
