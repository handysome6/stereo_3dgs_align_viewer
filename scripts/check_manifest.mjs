import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "public/data/afternoon/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const urls = [
  manifest.assets?.splatUrl,
  manifest.assets?.frustumSplatUrl,
  manifest.assets?.occlusionProxyUrl,
  ...(manifest.frames ?? []).flatMap((frame) => [frame.cloudUrl, frame.thumbnailUrl].filter(Boolean)),
].filter(Boolean);

const missing = [];
for (const url of urls) {
  const localPath = path.join(root, "public", url.replace(/^\//, ""));
  try {
    await access(localPath, constants.R_OK);
  } catch {
    missing.push(url);
  }
}

if (!Array.isArray(manifest.frames) || manifest.frames.length === 0) {
  missing.push("manifest.frames must be generated before data checks pass");
}

if (missing.length) {
  console.error("Data check failed:");
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(`Data check passed: ${manifest.frames.length} frames, ${urls.length} referenced assets.`);
