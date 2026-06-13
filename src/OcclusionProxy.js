import * as THREE from "three";

export class OcclusionProxy {
  constructor({ gridWidth = 180, gridHeight = 120, depthBias = 0.03, rayCellSize = 0.32, depthPointStride = 1 } = {}) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.depthBias = depthBias;
    this.rayCellSize = rayCellSize;
    this.rayCellInverse = 1 / rayCellSize;
    this.depthPointStride = Math.max(1, Math.floor(depthPointStride));
    this.depth = new Float32Array(gridWidth * gridHeight);
    this.points = null;
    this.spatialCells = null;
    this.spatialScratch = new Set();
    this.projected = new THREE.Vector3();
    this.lastUpdate = 0;
  }

  async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load occlusion proxy: ${response.status}`);
    const buffer = await response.arrayBuffer();
    this.points = new Float32Array(buffer);
    if (this.points.length % 3 !== 0) {
      throw new Error("Occlusion proxy must be float32 xyz triples");
    }
    this.buildSpatialIndex();
  }

  get count() {
    return this.points ? this.points.length / 3 : 0;
  }

  update(camera, now = performance.now()) {
    if (!this.points) return;
    this.depth.fill(Number.POSITIVE_INFINITY);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const pointStep = 3 * this.depthPointStride;
    for (let index = 0; index < this.points.length; index += pointStep) {
      this.projected.set(this.points[index], this.points[index + 1], this.points[index + 2]).project(camera);
      if (
        this.projected.x < -1 ||
        this.projected.x > 1 ||
        this.projected.y < -1 ||
        this.projected.y > 1 ||
        this.projected.z < -1 ||
        this.projected.z > 1
      ) {
        continue;
      }

      const gridX = Math.min(this.gridWidth - 1, Math.max(0, Math.floor(((this.projected.x + 1) * 0.5) * this.gridWidth)));
      const gridY = Math.min(this.gridHeight - 1, Math.max(0, Math.floor(((-this.projected.y + 1) * 0.5) * this.gridHeight)));
      const offset = gridY * this.gridWidth + gridX;
      if (this.projected.z < this.depth[offset]) {
        this.depth[offset] = this.projected.z;
      }
    }
    this.lastUpdate = now;
  }

  isOccluded(worldPosition, camera, radius = 1) {
    if (!this.points) return false;
    this.projected.copy(worldPosition).project(camera);
    if (
      this.projected.x < -1 ||
      this.projected.x > 1 ||
      this.projected.y < -1 ||
      this.projected.y > 1 ||
      this.projected.z < -1 ||
      this.projected.z > 1
    ) {
      return false;
    }

    const gridX = Math.min(this.gridWidth - 1, Math.max(0, Math.floor(((this.projected.x + 1) * 0.5) * this.gridWidth)));
    const gridY = Math.min(this.gridHeight - 1, Math.max(0, Math.floor(((-this.projected.y + 1) * 0.5) * this.gridHeight)));
    let closest = Number.POSITIVE_INFINITY;

    for (let y = Math.max(0, gridY - radius); y <= Math.min(this.gridHeight - 1, gridY + radius); y += 1) {
      for (let x = Math.max(0, gridX - radius); x <= Math.min(this.gridWidth - 1, gridX + radius); x += 1) {
        closest = Math.min(closest, this.depth[y * this.gridWidth + x]);
      }
    }
    return closest < this.projected.z - this.depthBias;
  }

  isRayOccluded(origin, target, radius = 0.015, nearPadding = 0.08, targetPadding = 0.08) {
    return this.countOccludedRays(origin, [target], radius, nearPadding, targetPadding, 1) > 0;
  }

  countOccludedRays(origin, targets, radius = 0.015, nearPadding = 0.08, targetPadding = 0.08, stopAfter = targets.length) {
    if (!this.points || !targets.length) return 0;

    const rays = [];
    for (const target of targets) {
      const dx = target.x - origin.x;
      const dy = target.y - origin.y;
      const dz = target.z - origin.z;
      const length = Math.hypot(dx, dy, dz);
      if (length <= nearPadding + targetPadding) continue;

      rays.push({
        dirX: dx / length,
        dirY: dy / length,
        dirZ: dz / length,
        maxAlong: length - targetPadding,
        hit: false,
      });
    }

    if (!rays.length) return 0;

    if (this.spatialCells) {
      return this.countOccludedRaysSpatial(origin, rays, radius, nearPadding, stopAfter);
    }

    return this.countOccludedRaysLinear(origin, rays, radius, nearPadding, stopAfter);
  }

  buildSpatialIndex() {
    const cells = new Map();
    for (let index = 0; index < this.points.length; index += 3) {
      const key = this.cellKeyFromPoint(this.points[index], this.points[index + 1], this.points[index + 2]);
      let bucket = cells.get(key);
      if (!bucket) {
        bucket = [];
        cells.set(key, bucket);
      }
      bucket.push(index);
    }
    this.spatialCells = cells;
  }

  countOccludedRaysLinear(origin, rays, radius, nearPadding, stopAfter) {
    const radiusSq = radius * radius;
    let hitCount = 0;

    for (let index = 0; index < this.points.length; index += 3) {
      const px = this.points[index];
      const py = this.points[index + 1];
      const pz = this.points[index + 2];
      const vx = px - origin.x;
      const vy = py - origin.y;
      const vz = pz - origin.z;

      for (const ray of rays) {
        if (ray.hit) continue;

        const along = vx * ray.dirX + vy * ray.dirY + vz * ray.dirZ;
        if (along <= nearPadding || along >= ray.maxAlong) continue;

        const distanceSq = vx * vx + vy * vy + vz * vz - along * along;
        if (distanceSq >= radiusSq) continue;

        ray.hit = true;
        hitCount += 1;
        if (hitCount >= stopAfter) return hitCount;
      }
    }

    return hitCount;
  }

  countOccludedRaysSpatial(origin, rays, radius, nearPadding, stopAfter) {
    const radiusSq = radius * radius;
    let hitCount = 0;

    for (const ray of rays) {
      if (!this.isSpatialRayOccluded(origin, ray, radius, radiusSq, nearPadding)) continue;
      hitCount += 1;
      if (hitCount >= stopAfter) return hitCount;
    }

    return hitCount;
  }

  isSpatialRayOccluded(origin, ray, radius, radiusSq, nearPadding) {
    const neighborRadius = Math.max(1, Math.ceil(radius * this.rayCellInverse));
    const step = Math.max(radius, this.rayCellSize * 0.5);
    const visited = this.spatialScratch;
    visited.clear();

    for (let along = nearPadding; along <= ray.maxAlong; along += step) {
      const cellX = this.cellCoord(origin.x + ray.dirX * along);
      const cellY = this.cellCoord(origin.y + ray.dirY * along);
      const cellZ = this.cellCoord(origin.z + ray.dirZ * along);

      for (let z = cellZ - neighborRadius; z <= cellZ + neighborRadius; z += 1) {
        for (let y = cellY - neighborRadius; y <= cellY + neighborRadius; y += 1) {
          for (let x = cellX - neighborRadius; x <= cellX + neighborRadius; x += 1) {
            const key = this.cellKey(x, y, z);
            if (visited.has(key)) continue;
            visited.add(key);

            const bucket = this.spatialCells.get(key);
            if (!bucket || !this.isBucketRayOccluded(bucket, origin, ray, radiusSq, nearPadding)) continue;
            visited.clear();
            return true;
          }
        }
      }
    }

    visited.clear();
    return false;
  }

  isBucketRayOccluded(bucket, origin, ray, radiusSq, nearPadding) {
    for (const index of bucket) {
      const vx = this.points[index] - origin.x;
      const vy = this.points[index + 1] - origin.y;
      const vz = this.points[index + 2] - origin.z;
      const along = vx * ray.dirX + vy * ray.dirY + vz * ray.dirZ;
      if (along <= nearPadding || along >= ray.maxAlong) continue;

      const distanceSq = vx * vx + vy * vy + vz * vz - along * along;
      if (distanceSq < radiusSq) return true;
    }

    return false;
  }

  cellCoord(value) {
    return Math.floor(value * this.rayCellInverse);
  }

  cellKeyFromPoint(x, y, z) {
    return this.cellKey(this.cellCoord(x), this.cellCoord(y), this.cellCoord(z));
  }

  cellKey(x, y, z) {
    return `${x},${y},${z}`;
  }
}
