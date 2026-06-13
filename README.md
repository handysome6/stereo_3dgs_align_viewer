# Afternoon 3DGS Camera Viewer

Spark/Three.js rewrite of the original 3DGS point-cloud viewer.

The app renders the trained Gaussian splat as the maneuvering view, draws the registered stereo camera frustums as real Three.js objects, and lets a user click a camera to load the matching world-aligned stereo point cloud.

## Run

```bash
npm install
npm run build:data
npm run dev
```

`build:data` uses `uv run --with numpy` so NumPy is available without relying on a global Python install.

## Controls

- Orbit/zoom/pan in the main 3DGS view.
- Click a camera frustum in the scene, or click a timestamp row, to load that frame's point cloud.
- Selecting a camera jumps to that registered capture angle.
- Toolbar buttons toggle fit view, splat visibility, selected cloud visibility, camera frustums, occlusion checks, and the decorative frustum splat layer.
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

- Spark renders `AFTERNOON_ONLY.ply` in the same Three.js scene as the interactive helpers.
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
