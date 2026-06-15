# Stereo 3DGS Align Viewer

## Setup On Another Computer

Clone the repo and install dependencies:

```bash
git clone git@github.com:handysome6/stereo_3dgs_align_viewer.git
cd stereo_3dgs_align_viewer
npm install
```

Prepare the same raw dataset locally. The viewer expects these inputs:

```text
afternoon_data/
  AFTERNOON_ONLY.ply
  stereo_camera_frustums.ply
  stereo_camera_poses.json

20260612_littlehouse_stereo/
  <timestamp>/
    cloud.ply
    rect_left.jpg   # optional thumbnail, or img0.jpg
```

Generate the local web assets using your own dataset paths:

```bash
npm run build:data -- \
  --afternoon-dir /path/to/afternoon_data \
  --stereo-dir /path/to/20260612_littlehouse_stereo
```

By default this builds static stereo PLY files with hybrid sampling: a small `0.006` voxel-grid pass first, then image-tile stratified fill up to `1,000,000` points per cloud. You can tune or compare modes without changing the viewer:

```bash
npm run build:data -- \
  --cloud-sampling-mode hybrid \
  --cloud-voxel-size 0.006 \
  --max-cloud-points 1000000
```

Start the dev server:

```bash
npm run dev
```

Open the printed Vite URL, usually:

```text
http://127.0.0.1:5173/
```

## Controls

- The left/main 3DGS view is the maneuver view.
- Click the 3DGS view once to focus it, then use `W/A/S/D` to move.
- Drag with the left mouse button inside the 3DGS view to look around.
- Use `Q/E` to move down/up along the fitted ground normal.
- Click a camera frustum/icon in the 3DGS view, or click a timestamp in the right panel, to load that camera's stereo point cloud.
- The stereo PLY view starts from the stereo camera origin and looks along camera `+Z`; orbit/zoom/pan are available there with the mouse.
- Use the toolbar buttons to reset views, swap the two viewports, toggle splat/cloud visibility, toggle camera frustums, and toggle occlusion hiding.

## Notes

Large generated assets are intentionally not committed to Git. `build:data` creates `public/data/afternoon/` locally, including the decimated stereo-camera PLY files used by the browser viewer.

`build:data` uses `uv run --with numpy`, so install `uv` first if needed:

```bash
brew install uv
```

If symlinks fail on the target machine, copy the large splat/frustum files instead:

```bash
npm run build:data -- \
  --afternoon-dir /path/to/afternoon_data \
  --stereo-dir /path/to/20260612_littlehouse_stereo \
  --copy-large-assets
```

## Verify

```bash
npm test
```
