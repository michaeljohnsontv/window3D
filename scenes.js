// scenes.js — test scenes. All sizes are in metres in screen coordinates
// (origin at screen centre, +Z toward the viewer, behind the glass is -Z).
//
// Each builder returns { root, background, update(tSeconds), dispose() }.
// Palette: greys, whites and blues (pure red/cyan breaks anaglyph).

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const SCENE_OPTIONS = [
  ['grid', 'Grid room'],
  ['objects', 'Floating objects'],
  ['ghost', 'Ghosting test'],
];

const BG_DARK = '#1b2331';
// Soft grey for outlines and edges: bright, high-contrast edges ghost badly
// through leaky anaglyph lenses. Further scaled by the Edge brightness slider.
const EDGE = '#8c929b';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fatLines(positions, color, widthPx, opacity = 1) {
  const geo = new LineSegmentsGeometry();
  geo.setPositions(positions);
  const mat = new LineMaterial({
    color: new THREE.Color(color).getHex(),
    linewidth: widthPx,
    transparent: opacity < 1,
    opacity,
  });
  mat.userData.edgeColor = new THREE.Color(color);
  const line = new LineSegments2(geo, mat);
  line.computeLineDistances();
  return line;
}

function edgeLines(geometry, color, widthPx) {
  const geo = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(geometry, 20));
  const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: widthPx });
  mat.userData.edgeColor = new THREE.Color(color);
  return new LineSegments2(geo, mat);
}

/** Inverted-hull outline: back faces pushed out along the normal. */
function hullMaterial(color, thickness) {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.userData.edgeColor = new THREE.Color(color);
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n  transformed += normalize(normal) * ${thickness.toFixed(5)};`
    );
  };
  return m;
}

function addLights(root, intensity = 1) {
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a2030, 1.2 * intensity);
  root.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.6 * intensity);
  key.position.set(0.5, 0.8, 1.0);
  root.add(key);
  const fill = new THREE.DirectionalLight(0x9db8ff, 0.5 * intensity);
  fill.position.set(-0.8, -0.2, 0.6);
  root.add(fill);
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

function labelMesh(text, heightM, color = '#ffffff') {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const px = 64;
  ctx.font = `600 ${px}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w;
  c.height = px + 16;
  ctx.font = `600 ${px}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry((heightM * c.width) / c.height, heightM), mat);
  return mesh;
}

// ---------------------------------------------------------------------------
// Grid room: a box behind the screen, opening flush with the screen edges.
// ---------------------------------------------------------------------------

function gridRoom(W, H, D, opts = {}) {
  const {
    spacing = 0.05,
    wallColor = '#232d3f',
    lineColor = '#4a5568',
    rimColor = '#8a919c',
    lineWidth = 1.2,
    rimWidth = 2,
    lineOpacity = 1,
  } = opts;
  const g = new THREE.Group();

  const wallMat = new THREE.MeshStandardMaterial({
    color: wallColor,
    roughness: 0.95,
    metalness: 0,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), wallMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -H / 2, -D / 2);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), wallMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, H / 2, -D / 2);
  const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-W / 2, 0, -D / 2);
  const right = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
  right.rotation.y = -Math.PI / 2;
  right.position.set(W / 2, 0, -D / 2);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  back.position.set(0, 0, -D);
  g.add(floor, ceil, left, right, back);

  const div = (len) => Math.max(1, Math.round(len / spacing));
  const nx = div(W), ny = div(H), nz = div(D);
  const xs = Array.from({ length: nx + 1 }, (_, i) => -W / 2 + (i * W) / nx);
  const ys = Array.from({ length: ny + 1 }, (_, i) => -H / 2 + (i * H) / ny);
  const zs = Array.from({ length: nz + 1 }, (_, i) => -(i * D) / nz);

  const p = [];
  // floor + ceiling
  for (const y of [-H / 2, H / 2]) {
    for (const x of xs) p.push(x, y, 0, x, y, -D);
    for (const z of zs) p.push(-W / 2, y, z, W / 2, y, z);
  }
  // side walls
  for (const x of [-W / 2, W / 2]) {
    for (const y of ys) p.push(x, y, 0, x, y, -D);
    for (const z of zs) p.push(x, -H / 2, z, x, H / 2, z);
  }
  // back wall
  for (const x of xs) p.push(x, -H / 2, -D, x, H / 2, -D);
  for (const y of ys) p.push(-W / 2, y, -D, W / 2, y, -D);
  g.add(fatLines(p, lineColor, lineWidth, lineOpacity));

  // Bright rim: the opening (= the screen edges) and the four long edges.
  const r = [];
  const corners = [
    [-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % 4];
    r.push(x0, y0, 0, x1, y1, 0); // opening
    r.push(x0, y0, -D, x1, y1, -D); // back rectangle
    r.push(x0, y0, 0, x0, y0, -D); // depth edge
  }
  g.add(fatLines(r, rimColor, rimWidth));
  return g;
}

function buildGridScene(W, H) {
  const root = new THREE.Group();
  const D = W; // as deep as it is wide
  addLights(root, 0.9);
  root.add(gridRoom(W, H, D));

  // A couple of depth landmarks inside the room.
  const sphereGeo = new THREE.SphereGeometry(Math.min(H, W) * 0.09, 48, 32);
  const sphere = new THREE.Mesh(
    sphereGeo,
    new THREE.MeshStandardMaterial({ color: '#c9d4e6', roughness: 0.5 })
  );
  sphere.position.set(W * 0.18, 0, -D * 0.55);
  const sphereHull = new THREE.Mesh(sphereGeo, hullMaterial(EDGE, 0.002));
  sphere.add(sphereHull);
  root.add(sphere);

  const cubeSize = H * 0.25;
  const cubeGeo = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
  const cube = new THREE.Mesh(cubeGeo, new THREE.MeshStandardMaterial({ color: '#3f68b5', roughness: 0.6 }));
  cube.position.set(-W * 0.22, -H / 2 + cubeSize / 2, -D * 0.3);
  cube.add(edgeLines(cubeGeo, EDGE, 1.5));
  root.add(cube);

  return {
    root,
    background: new THREE.Color(BG_DARK),
    update() {},
    dispose: () => disposeTree(root),
  };
}

// ---------------------------------------------------------------------------
// Floating objects: in front of and behind the screen, slowly rotating.
// ---------------------------------------------------------------------------

function buildObjectsScene(W, H) {
  const root = new THREE.Group();
  addLights(root, 1);
  // Dim room behind for a depth reference.
  root.add(
    gridRoom(W, H, W * 0.9, {
      wallColor: '#1e2736',
      lineColor: '#333b48',
      rimColor: '#5c6470',
      lineWidth: 1,
      rimWidth: 1.5,
    })
  );

  const s = Math.min(H / 0.34, W / 0.8); // scale relative to the reference 0.80×0.34 m screen
  const items = [];
  const OUT = EDGE;

  function add(mesh, pos, spin, outline) {
    mesh.position.set(pos[0] * W, pos[1] * H, pos[2]);
    if (outline === 'edges') mesh.add(edgeLines(mesh.geometry, OUT, 1.5));
    else mesh.add(new THREE.Mesh(mesh.geometry, hullMaterial(OUT, 0.0018 * s)));
    root.add(mesh);
    items.push({ mesh, spin });
  }

  const std = (color, rough = 0.5) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });

  // In front of the screen (positive Z, within ~15 cm), kept near centre so
  // they don't get cut off by the screen edges.
  add(new THREE.Mesh(new THREE.BoxGeometry(0.06 * s, 0.06 * s, 0.06 * s), std('#d8dee9')), [-0.12, 0.12, 0.1], [0.4, 0.6, 0], 'edges');
  add(new THREE.Mesh(new THREE.SphereGeometry(0.032 * s, 48, 32), std('#5b8ee6', 0.35)), [0.13, -0.12, 0.13], [0, 0.3, 0], 'hull');
  add(new THREE.Mesh(new THREE.TorusGeometry(0.05 * s, 0.014 * s, 32, 96), std('#9fb4d6', 0.4)), [0.0, 0.05, 0.06], [0.5, 0.3, 0.1], 'hull');

  // At / behind the screen.
  add(new THREE.Mesh(new THREE.BoxGeometry(0.1 * s, 0.1 * s, 0.1 * s), std('#3d64ad')), [-0.3, -0.15, -0.15], [0.2, 0.35, 0.1], 'edges');
  add(new THREE.Mesh(new THREE.SphereGeometry(0.07 * s, 48, 32), std('#e8ecf3', 0.6)), [0.3, 0.15, -0.3], [0, 0.2, 0], 'hull');
  add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.07 * s, 0), std('#7f93b3')), [-0.08, -0.2, -0.45], [0.3, 0.2, 0.15], 'edges');
  add(new THREE.Mesh(new THREE.TorusGeometry(0.09 * s, 0.025 * s, 32, 96), std('#2f5cb0', 0.45)), [0.18, -0.05, -0.65], [0.15, 0.4, 0], 'hull');
  add(new THREE.Mesh(new THREE.BoxGeometry(0.14 * s, 0.14 * s, 0.14 * s), std('#a7b1c2')), [-0.33, 0.18, -0.7], [0.1, 0.25, 0.05], 'edges');

  return {
    root,
    background: new THREE.Color(BG_DARK),
    update(t, dt) {
      for (const { mesh, spin } of items) {
        mesh.rotation.x += spin[0] * dt;
        mesh.rotation.y += spin[1] * dt;
        mesh.rotation.z += spin[2] * dt;
      }
    },
    dispose: () => disposeTree(root),
  };
}

// ---------------------------------------------------------------------------
// Ghosting test: white and grey bars at several depths on mid-grey.
// ---------------------------------------------------------------------------

function buildGhostScene(W, H) {
  const root = new THREE.Group();
  const depths = [0.1, 0.05, 0, -0.1, -0.3];
  const n = depths.length;
  const colW = W / n;
  const REF_Z = 0.65; // scale bars so they look the same size from here
  const bars = [
    ['#ffffff', 'white'],
    ['#c4c4c4', 'light'],
    ['#3a3a3a', 'dark'],
    ['#000000', 'black'],
  ];

  depths.forEach((z, i) => {
    const k = (REF_Z - z) / REF_Z;
    const cx = (-W / 2 + colW * (i + 0.5)) * k;
    const bw = colW * 0.42 * k;
    const bh = H * 0.11 * k;
    const gap = H * 0.05 * k;
    const total = bars.length * bh + (bars.length - 1) * gap;
    const col = new THREE.Group();
    bars.forEach(([color], j) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(bw, bh),
        new THREE.MeshBasicMaterial({ color, toneMapped: false })
      );
      m.position.set(cx, (total / 2 - bh / 2 - j * (bh + gap)) * 1 - H * 0.05 * k, z);
      col.add(m);
    });
    // Thin vertical white line: a hard edge for spotting horizontal ghosts.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(0.002, bw * 0.03), total),
      new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false })
    );
    line.position.set(cx + bw * 0.7, -H * 0.05 * k, z);
    col.add(line);

    const label = labelMesh(`${z > 0 ? '+' : ''}${Math.round(z * 100)} cm`, H * 0.07 * k);
    label.position.set(cx, H * 0.38 * k, z);
    col.add(label);
    root.add(col);
  });

  // Screen-plane frame for reference (zero disparity, so it never ghosts).
  const fr = [];
  const c = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i];
    const [x1, y1] = c[(i + 1) % 4];
    fr.push(x0, y0, 0, x1, y1, 0);
  }
  root.add(fatLines(fr, '#b0b0b0', 2));

  return {
    root,
    background: new THREE.Color('#808080'),
    update() {},
    dispose: () => disposeTree(root),
  };
}

const BUILDERS = { grid: buildGridScene, objects: buildObjectsScene, ghost: buildGhostScene };

export function buildScene(id, W, H) {
  const b = BUILDERS[id] || BUILDERS.grid;
  return b(W, H);
}
