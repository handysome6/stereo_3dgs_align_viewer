import * as THREE from "three";

const threeCameraFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

export function quaternionWxyzToThree([w, x, y, z]) {
  return new THREE.Quaternion(x, y, z, w).normalize();
}

export function colmapCameraQuaternionToThree(quaternionWxyzC2w) {
  return quaternionWxyzToThree(quaternionWxyzC2w).multiply(threeCameraFix);
}

export function frameForward(frame) {
  const quaternion = colmapCameraQuaternionToThree(frame.quaternion_wxyz_c2w);
  return new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
}

export function framePosition(frame) {
  return new THREE.Vector3().fromArray(frame.position);
}

export function fitCameraToBox(camera, controls, box, viewDirection = new THREE.Vector3(0.65, -0.9, 0.48)) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.01);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const direction = viewDirection.clone().normalize();

  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, distance * 1.7);
  camera.near = Math.max(distance / 2500, 0.005);
  camera.far = Math.max(distance * 20, 100);
  camera.updateProjectionMatrix();
  controls.update();
}

export function boxFromFrames(frames) {
  const box = new THREE.Box3();
  for (const frame of frames) {
    box.expandByPoint(framePosition(frame));
    if (frame.cloudBounds) {
      box.expandByPoint(new THREE.Vector3().fromArray(frame.cloudBounds.min));
      box.expandByPoint(new THREE.Vector3().fromArray(frame.cloudBounds.max));
    }
    for (const point of frame.frustum ?? []) {
      box.expandByPoint(new THREE.Vector3().fromArray(point));
    }
  }
  return box;
}

export function setCameraToFrame(camera, controls, frame, focusBox = null) {
  const position = framePosition(frame);
  const forward = frameForward(frame);
  let focusDistance = 1.6;
  if (focusBox && !focusBox.isEmpty()) {
    const center = focusBox.getCenter(new THREE.Vector3());
    const projected = center.sub(position).dot(forward);
    if (Number.isFinite(projected) && projected > 0) {
      focusDistance = THREE.MathUtils.clamp(projected, 0.8, 8);
    }
  }
  camera.position.copy(position);
  controls.target.copy(position).addScaledVector(forward, focusDistance);
  camera.near = 0.005;
  camera.far = 1000;
  camera.updateProjectionMatrix();
  controls.update();
}
