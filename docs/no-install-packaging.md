# No-Install Packaging

This viewer can be shipped as a static bundle. The receiving machine does not need the raw stereo dataset, Python, npm, Vite, or the repo checkout. It only needs a modern browser with WebGL2. For a true no-install package, include a portable Node.js runtime and a tiny static server inside the package.

Do not ask users to open `dist/index.html` directly. The viewer loads assets with absolute `/data/...` URLs, so it must be served over local HTTP.

## Package Layout

```text
stereo_3dgs_viewer/
  dist/
    index.html
    assets/
    data/
      afternoon/
        AFTERNOON_ONLY.ply
        clouds/
        manifest.json
        occlusion_proxy.bin
        stereo_camera_frustums.ply
        thumbs/
  server/
    server.mjs
  runtime/
    node-macos-arm64/
      bin/node
    node-win-x64/
      node.exe
  run-macos.command
  run-windows.bat
```

Builds are OS-neutral, but launchers and Node runtimes are OS-specific. For Windows-only delivery, include only `node-win-x64` and `run-windows.bat`. For Apple Silicon macOS delivery, include only `node-macos-arm64` and `run-macos.command`.

## Build The Static Viewer

From the repo root:

```bash
npm run build:data
npm test
```

`npm test` runs the manifest check and `vite build`. The final static site is in `dist/`. Vite copies the public assets into `dist`, including symlink targets, so the package should not contain symlinks.

Check that the build is self-contained:

```bash
find dist -type l -print
du -sh dist
```

Expected result: no symlinks. Current `1,000,000` point-per-frame builds are roughly `1.4G`.

## Create The Release Folder

```bash
rm -rf release/stereo_3dgs_viewer
mkdir -p release/stereo_3dgs_viewer/server
rsync -a --delete dist/ release/stereo_3dgs_viewer/dist/
```

## Add The Static Server

Create `release/stereo_3dgs_viewer/server/server.mjs`:

```js
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ply": "application/octet-stream",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

function fileForRequest(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(root, `.${relativePath}`);
  if (filePath !== root && !filePath.startsWith(rootPrefix)) return null;
  return filePath;
}

const server = createServer((request, response) => {
  const filePath = fileForRequest(request.url || "/");
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Stereo 3DGS Viewer: http://127.0.0.1:${port}/`);
});
```

## Add A Windows Launcher

Create `release/stereo_3dgs_viewer/run-windows.bat`:

```bat
@echo off
cd /d "%~dp0"

set PORT=4173
set NODE=%~dp0runtime\node-win-x64\node.exe

if not exist "%NODE%" (
  echo Bundled Node runtime not found:
  echo %NODE%
  pause
  exit /b 1
)

start "" "http://127.0.0.1:%PORT%/"
"%NODE%" "%~dp0server\server.mjs"
pause
```

Download the Windows x64 Node.js zip from the official Node.js site, then place its extracted folder at:

```text
release/stereo_3dgs_viewer/runtime/node-win-x64/
```

The folder must contain `node.exe` directly at:

```text
runtime/node-win-x64/node.exe
```

## Add A macOS Launcher

Create `release/stereo_3dgs_viewer/run-macos.command`:

```bash
#!/bin/zsh
cd "$(dirname "$0")"

PORT="${PORT:-4173}"
NODE="./runtime/node-macos-arm64/bin/node"

if [ ! -x "$NODE" ]; then
  echo "Bundled Node runtime not found or not executable:"
  echo "$NODE"
  read -r "?Press Enter to close..."
  exit 1
fi

open "http://127.0.0.1:$PORT/"
"$NODE" ./server/server.mjs
```

Make it executable:

```bash
chmod +x release/stereo_3dgs_viewer/run-macos.command
```

Download the Apple Silicon macOS Node.js tarball from the official Node.js site, then place its extracted folder at:

```text
release/stereo_3dgs_viewer/runtime/node-macos-arm64/
```

The folder must contain the node binary at:

```text
runtime/node-macos-arm64/bin/node
```

For Intel macOS, use the macOS x64 Node.js tarball instead and update the launcher path.

## Zip The Package

For macOS:

```bash
ditto -c -k --sequesterRsrc --keepParent release/stereo_3dgs_viewer stereo_3dgs_viewer_macos.zip
```

For Windows, create the zip with a tool that preserves the folder layout. From macOS or Linux:

```bash
cd release
zip -r ../stereo_3dgs_viewer_windows.zip stereo_3dgs_viewer
```

## User Instructions

Windows:

1. Unzip `stereo_3dgs_viewer_windows.zip`.
2. Double-click `run-windows.bat`.
3. Use the browser tab that opens at `http://127.0.0.1:4173/`.

macOS:

1. Unzip `stereo_3dgs_viewer_macos.zip`.
2. Double-click `run-macos.command`.
3. Use the browser tab that opens at `http://127.0.0.1:4173/`.

If macOS blocks the launcher because of quarantine, right-click it and choose Open once, or remove quarantine from the extracted folder:

```bash
xattr -dr com.apple.quarantine stereo_3dgs_viewer
```

## Verification Checklist

Before sending the package:

```bash
find release/stereo_3dgs_viewer/dist -type l -print
du -sh release/stereo_3dgs_viewer
```

Then run the launcher on a clean machine or test account and confirm:

- The app opens at `http://127.0.0.1:4173/`.
- The 3DGS view loads.
- Clicking a camera loads a `1,000,000` point stereo cloud.
- Browser devtools show no missing `/data/afternoon/...` assets.

