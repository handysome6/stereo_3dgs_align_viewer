import * as THREE from "three";

export class OcclusionProxy {
  constructor({ gridWidth = 180, gridHeight = 120, depthBias = 0.03 } = {}) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.depthBias = depthBias;
    this.depth = new Float32Array(gridWidth * gridHeight);
    this.points = null;
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
  }

  get count() {
    return this.points ? this.points.length / 3 : 0;
  }

  update(camera, now = performance.now()) {
    if (!this.points) return;
    this.depth.fill(Number.POSITIVE_INFINITY);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    for (let index = 0; index < this.points.length; index += 3) {
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
    if (!this.points) return false;
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const length = Math.hypot(dx, dy, dz);
    if (length <= nearPadding + targetPadding) return false;

    const dirX = dx / length;
    const dirY = dy / length;
    const dirZ = dz / length;
    const radiusSq = radius * radius;
    const maxAlong = length - targetPadding;

    for (let index = 0; index < this.points.length; index += 3) {
      const vx = this.points[index] - origin.x;
      const vy = this.points[index + 1] - origin.y;
      const vz = this.points[index + 2] - origin.z;
      const along = vx * dirX + vy * dirY + vz * dirZ;
      if (along <= nearPadding || along >= maxAlong) continue;

      const distanceSq = vx * vx + vy * vy + vz * vz - along * along;
      if (distanceSq < radiusSq) return true;
    }

    return false;
  }
}
