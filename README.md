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

Start the dev server:

```bash
npm run dev
```

Open the printed Vite URL, usually:

```text
http://127.0.0.1:5173/
```

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
