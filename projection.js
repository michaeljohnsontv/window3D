// projection.js — off-axis (asymmetric frustum) projection maths.
//
// Coordinate system (metres): origin at the centre of the screen's lit area,
// +X right, +Y up, +Z out of the screen toward the viewer. Content "behind the
// glass" has negative Z.
//
// The core routine is Robert Kooima's "Generalized Perspective Projection".
// A screen is described by three of its corners:
//   pa = lower-left, pb = lower-right, pc = upper-left
// For the flat screen at z = 0 facing +Z this reduces exactly to
//   left   = (xL - eye.x) * n / eye.z
//   right  = (xR - eye.x) * n / eye.z
//   bottom = (yB - eye.y) * n / eye.z
//   top    = (yT - eye.y) * n / eye.z
// with an un-rotated camera looking down -Z. Using the general form now means
// a second screen at an angle (the corner-CAVE version) only needs its own
// corners and its own camera.

import * as THREE from 'three';

const _vr = new THREE.Vector3();
const _vu = new THREE.Vector3();
const _vn = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/** A screen rectangle in the z = 0 plane, facing +Z. */
export function flatScreenRect(xLeft, xRight, yBottom, yTop, z = 0) {
  return {
    pa: new THREE.Vector3(xLeft, yBottom, z),
    pb: new THREE.Vector3(xRight, yBottom, z),
    pc: new THREE.Vector3(xLeft, yTop, z),
  };
}

/** Update an existing flat rect in place (avoids per-frame allocation). */
export function setFlatScreenRect(rect, xLeft, xRight, yBottom, yTop, z = 0) {
  rect.pa.set(xLeft, yBottom, z);
  rect.pb.set(xRight, yBottom, z);
  rect.pc.set(xLeft, yTop, z);
  return rect;
}

/** Frustum extents at the near plane for a flat z=0 screen (simple form). */
export function flatOffAxisExtents(eye, xLeft, xRight, yBottom, yTop, near) {
  const ez = Math.max(eye.z, 1e-3);
  const k = near / ez;
  return {
    left: (xLeft - eye.x) * k,
    right: (xRight - eye.x) * k,
    bottom: (yBottom - eye.y) * k,
    top: (yTop - eye.y) * k,
  };
}

/**
 * Point `camera` at `screen` from `eye` using Kooima's generalized perspective
 * projection. Sets the camera pose and writes camera.projectionMatrix directly.
 * Do NOT call camera.updateProjectionMatrix() afterwards — it would overwrite
 * the custom matrix.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {{pa:THREE.Vector3,pb:THREE.Vector3,pc:THREE.Vector3}} screen
 * @param {THREE.Vector3} eye  eye position in world (screen) coordinates
 * @returns {{left:number,right:number,bottom:number,top:number,distance:number}}
 */
export function applyOffAxisProjection(camera, screen, eye, near, far) {
  const { pa, pb, pc } = screen;

  // Orthonormal screen basis.
  _vr.subVectors(pb, pa).normalize(); // right
  _vu.subVectors(pc, pa).normalize(); // up
  _vn.crossVectors(_vr, _vu).normalize(); // normal, toward viewer

  // Vectors from eye to corners.
  _va.subVectors(pa, eye);
  _vb.subVectors(pb, eye);
  _vc.subVectors(pc, eye);

  // Distance from eye to screen plane. Clamp so the eye never reaches/passes
  // the glass (the frustum would flip).
  const d = Math.max(-_va.dot(_vn), 1e-3);
  const k = near / d;

  const left = _vr.dot(_va) * k;
  const right = _vr.dot(_vb) * k;
  const bottom = _vu.dot(_va) * k;
  const top = _vu.dot(_vc) * k;

  // Camera at the eye, oriented to the screen basis (identity for a flat
  // screen facing +Z — the camera looks straight down -Z, no rotation).
  camera.position.copy(eye);
  _basis.makeBasis(_vr, _vu, _vn);
  camera.quaternion.setFromRotationMatrix(_basis);
  camera.updateMatrixWorld(true);

  camera.near = near;
  camera.far = far;
  camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  return { left, right, bottom, top, distance: d };
}
