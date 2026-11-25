// main.js — app setup, render loop, UI wiring.

import * as THREE from 'three';
import { applyOffAxisProjection, flatScreenRect, setFlatScreenRect } from './projection.js';
import {
  FaceTracker,
  CameraError,
  Vec3OneEuro,
  estimateEye,
  effectivePupilPx,
  solveFovFromDistance,
} from './tracking.js';
import { buildScene, SCENE_OPTIONS } from './scenes.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'window3d.settings.v1';

const STEREO_OPTIONS = [
  ['off', 'Off (mono)'],
  ['redcyan', 'Red-cyan'],
  ['dubois', 'Red-cyan (Dubois)'],
];

const DEFS = [
  { group: 'Screen' },
  { key: 'screenW', label: 'Active width (m)', type: 'number', def: 0.8, step: 0.005, min: 0.1, max: 5,
    hint: '34" ultrawide ≈ 0.80 × 0.34 m. Measure the lit area.' },
  { key: 'screenH', label: 'Active height (m)', type: 'number', def: 0.34, step: 0.005, min: 0.05, max: 3 },
  { key: 'windowCorrection', label: 'Correct for window position', type: 'checkbox', def: true,
    hint: 'When not fullscreen, estimate where the browser window sits on the screen.' },

  { group: 'Webcam' },
  { key: 'camX', label: 'Offset X (m)', type: 'number', def: 0, step: 0.005, min: -3, max: 3 },
  { key: 'camYTop', label: 'Y above top edge (m)', type: 'number', def: 0.01, step: 0.005, min: -3, max: 3,
    hint: 'Webcam Y = screen height/2 + this.' },
  { key: 'camZ', label: 'Offset Z (m)', type: 'number', def: 0, step: 0.005, min: -1, max: 1 },
  { key: 'camTilt', label: 'Tilt down (°)', type: 'number', def: 0, step: 0.5, min: -45, max: 45 },
  { key: 'camFov', label: 'Horizontal FOV (°)', type: 'number', def: 60, step: 0.5, min: 20, max: 150,
    hint: 'Adjust (or use Calibrate) if the distance looks wrong.' },

  { group: 'Tracking' },
  { key: 'ipdMm', label: 'Assumed IPD (mm)', type: 'number', def: 63, step: 0.5, min: 45, max: 80 },
  { key: 'smoothing', label: 'Smoothing', type: 'range', def: 0.5, step: 0.01, min: 0, max: 1 },
  { key: 'yawComp', label: 'Head-turn compensation', type: 'checkbox', def: true },

  { group: 'Stereo' },
  { key: 'stereo', label: 'Mode', type: 'select', def: 'dubois', options: STEREO_OPTIONS },
  { key: 'eyeSep', label: 'Eye separation ×', type: 'range', def: 1, step: 0.01, min: 0, max: 1.5 },
  { key: 'balance', label: 'L/R brightness', type: 'range', def: 0, step: 0.01, min: -0.3, max: 0.3,
    hint: '+ brightens the left (red) eye, − the right (cyan) eye.' },
  { key: 'swapEyes', label: 'Swap eyes', type: 'checkbox', def: false },

  { group: 'View' },
  { key: 'scene', label: 'Scene', type: 'select', def: 'grid', options: SCENE_OPTIONS },
  { key: 'debug', label: 'Show debug', type: 'checkbox', def: false },
];

function loadSettings() {
  const s = {};
  for (const d of DEFS) if (d.key) s[d.key] = d.def;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const d of DEFS) {
        if (!d.key || saved[d.key] === undefined || typeof saved[d.key] !== typeof d.def) continue;
        if (d.type === 'select' && !d.options.some(([v]) => v === saved[d.key])) continue;
        if (typeof d.def === 'number' && !Number.isFinite(saved[d.key])) continue;
        s[d.key] = saved[d.key];
      }
    }
  } catch (e) {
    console.warn('Could not read saved settings', e);
  }
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    /* storage unavailable (private mode etc.) — settings just won't persist */
  }
}

const settings = loadSettings();

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const panel = $('panel');
const video = $('video');
const camWrap = $('camWrap');
const camOverlay = $('camOverlay');
const debugText = $('debugText');
const statusEl = $('status');
const intro = $('intro');

const inputs = {};

function fmt(d, v) {
  if (d.key === 'smoothing') return v < 0.2 ? 'low' : v < 0.4 ? 'l-m' : v < 0.6 ? 'med' : v < 0.8 ? 'm-h' : 'high';
  if (d.key === 'balance') return (v > 0 ? '+' : '') + v.toFixed(2);
  return v.toFixed(2);
}

function buildPanel() {
  const form = $('settingsForm');
  form.innerHTML = '';
  for (const d of DEFS) {
    if (d.group) {
      const g = document.createElement('div');
      g.className = 'group';
      g.textContent = d.group;
      form.appendChild(g);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'row' + (d.type === 'range' ? ' range' : '');
    const id = 'set_' + d.key;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = d.label;
    row.appendChild(label);

    let input;
    if (d.type === 'select') {
      input = document.createElement('select');
      for (const [v, text] of d.options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = text;
        input.appendChild(o);
      }
      input.value = settings[d.key];
      input.addEventListener('change', () => setSetting(d.key, input.value));
      row.appendChild(input);
    } else if (d.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = settings[d.key];
      input.addEventListener('change', () => setSetting(d.key, input.checked));
      row.appendChild(input);
    } else if (d.type === 'range') {
      const wrap = document.createElement('div');
      wrap.className = 'rangewrap';
      input = document.createElement('input');
      input.type = 'range';
      Object.assign(input, { min: d.min, max: d.max, step: d.step });
      input.value = settings[d.key];
      const out = document.createElement('output');
      out.textContent = fmt(d, settings[d.key]);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        out.textContent = fmt(d, v);
        setSetting(d.key, v);
      });
      input._out = out;
      wrap.append(input, out);
      row.appendChild(wrap);
    } else {
      input = document.createElement('input');
      input.type = 'number';
      Object.assign(input, { min: d.min, max: d.max, step: d.step });
      input.value = settings[d.key];
      input.addEventListener('change', () => {
        let v = parseFloat(input.value);
        if (!Number.isFinite(v)) v = d.def;
        v = Math.min(Math.max(v, d.min), d.max);
        input.value = v;
        setSetting(d.key, v);
      });
      row.appendChild(input);
    }
    input.id = id;
    inputs[d.key] = { input, def: d };

    if (d.hint) {
      const h = document.createElement('div');
      h.className = 'hint';
      h.textContent = d.hint;
      row.appendChild(h);
    }
    form.appendChild(row);
  }
}

function syncInput(key) {
  const entry = inputs[key];
  if (!entry) return;
  const { input, def } = entry;
  if (def.type === 'checkbox') input.checked = settings[key];
  else input.value = settings[key];
  if (input._out) input._out.textContent = fmt(def, settings[key]);
}

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  syncInput(key);
  onSettingChanged(key);
}

function onSettingChanged(key) {
  if (key === 'screenW' || key === 'screenH' || key === 'scene') rebuildScene();
  if (key === 'smoothing') filter.setStrength(settings.smoothing);
  if (key === 'debug') document.body.classList.toggle('debug', settings.debug);
}

let statusTimer = 0;
function showStatus(text, kind = '', ms = 0) {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.className = text ? `show ${kind}` : '';
  if (text && ms) statusTimer = setTimeout(() => showStatus(''), ms);
}

// ---------------------------------------------------------------------------
// Renderer, cameras, anaglyph compositor
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const NEAR = 0.01;
const FAR = 50;
const camMono = new THREE.PerspectiveCamera();
const camL = new THREE.PerspectiveCamera();
const camR = new THREE.PerspectiveCamera();
for (const c of [camMono, camL, camR]) c.matrixAutoUpdate = true;

const rtOpts = { type: THREE.HalfFloatType, samples: 4, depthBuffer: true };
const rtL = new THREE.WebGLRenderTarget(1, 1, rtOpts);
const rtR = new THREE.WebGLRenderTarget(1, 1, rtOpts);

// Colour matrices (row-major, applied in linear light).
const MATRICES = {
  // Dubois least-squares red-cyan matrices (as used by three.js AnaglyphEffect).
  dubois: {
    L: [0.4561, 0.500484, 0.176381, -0.0400822, -0.0378246, -0.0157589, -0.0152161, -0.0205971, -0.00546856],
    R: [-0.0434706, -0.0879388, -0.00155529, 0.378476, 0.73364, -0.0184503, -0.0721527, -0.112961, 1.2264],
  },
  // "Half-colour" red-cyan: left eye gets luminance in red, right eye gets
  // the original green and blue. Less retinal rivalry than full colour.
  redcyan: {
    L: [0.299, 0.587, 0.114, 0, 0, 0, 0, 0, 0],
    R: [0, 0, 0, 0, 1, 0, 0, 0, 1],
  },
};

const composeMat = new THREE.ShaderMaterial({
  uniforms: {
    mapL: { value: rtL.texture },
    mapR: { value: rtR.texture },
    matL: { value: new THREE.Matrix3() },
    matR: { value: new THREE.Matrix3() },
    gainL: { value: 1 },
    gainR: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D mapL;
    uniform sampler2D mapR;
    uniform mat3 matL;
    uniform mat3 matR;
    uniform float gainL;
    uniform float gainR;
    varying vec2 vUv;
    void main() {
      vec3 l = texture2D(mapL, vUv).rgb;
      vec3 r = texture2D(mapR, vUv).rgb;
      vec3 c = clamp(matL * l, 0.0, 1.0) * gainL + clamp(matR * r, 0.0, 1.0) * gainR;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      #include <colorspace_fragment>
    }
  `,
  depthTest: false,
  depthWrite: false,
});
const composeScene = new THREE.Scene();
const composeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), composeMat);
composeQuad.frustumCulled = false;
composeScene.add(composeQuad);
const composeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function setMatrices(mode) {
  const m = MATRICES[mode] || MATRICES.dubois;
  composeMat.uniforms.matL.value.set(...m.L);
  composeMat.uniforms.matR.value.set(...m.R);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
let current = null;

function rebuildScene() {
  if (current) {
    scene.remove(current.root);
    current.dispose();
  }
  current = buildScene(settings.scene, settings.screenW, settings.screenH);
  scene.add(current.root);
  scene.background = current.background;
  updateLineResolution();
}

function updateLineResolution() {
  if (!current) return;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  current.root.traverse((o) => {
    if (o.material && o.material.isLineMaterial) o.material.resolution.set(size.x, size.y);
  });
}

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  rtL.setSize(size.x, size.y);
  rtR.setSize(size.x, size.y);
  updateLineResolution();
}
window.addEventListener('resize', onResize);
document.addEventListener('fullscreenchange', onResize);

// ---------------------------------------------------------------------------
// Physical viewport: which part of the physical screen the canvas covers.
// ---------------------------------------------------------------------------

const viewRect = flatScreenRect(-0.4, 0.4, -0.17, 0.17);
const viewInfo = { xL: 0, xR: 0, yB: 0, yT: 0, corrected: false };

function isFullscreen() {
  return !!document.fullscreenElement;
}

function updateViewRect() {
  const W = settings.screenW;
  const H = settings.screenH;
  let xL = -W / 2, xR = W / 2, yB = -H / 2, yT = H / 2;
  let corrected = false;

  if (settings.windowCorrection && !isFullscreen()) {
    const sw = screen.width, sh = screen.height;
    const iw = window.innerWidth, ih = window.innerHeight;
    if (sw > 0 && sh > 0 && iw > 0 && ih > 0 && (iw < sw - 1 || ih < sh - 1)) {
      const mx = W / sw, my = H / sh;
      const sLeft = screen.left ?? screen.availLeft ?? 0;
      const sTop = screen.top ?? 0;
      const chromeX = Math.max(0, (window.outerWidth - iw) / 2);
      const chromeY = Math.max(0, window.outerHeight - ih - chromeX);
      const px0 = window.screenX - sLeft + chromeX;
      const py0 = window.screenY - sTop + chromeY;
      if (px0 > -sw && px0 < sw && py0 > -sh && py0 < sh) {
        xL = -W / 2 + px0 * mx;
        xR = xL + iw * mx;
        yT = H / 2 - py0 * my;
        yB = yT - ih * my;
        corrected = true;
      }
    }
  }
  Object.assign(viewInfo, { xL, xR, yB, yT, corrected });
  setFlatScreenRect(viewRect, xL, xR, yB, yT);
}

// ---------------------------------------------------------------------------
// Eye position state
// ---------------------------------------------------------------------------

const DEFAULT_EYE = new THREE.Vector3(0, 0, 0.65);
const filter = new Vec3OneEuro();
filter.setStrength(settings.smoothing);

const eye = {
  mode: 'idle', // idle | camera | mouse
  raw: new THREE.Vector3().copy(DEFAULT_EYE),
  smoothed: new THREE.Vector3().copy(DEFAULT_EYE),
  display: new THREE.Vector3().copy(DEFAULT_EYE),
  mouse: new THREE.Vector3().copy(DEFAULT_EYE),
  lastFaceTime: -Infinity,
  blend: 0,
  lastObs: null,
};

const tracker = new FaceTracker(video);
let calib = null; // { until, samples: [] }

tracker.onResult = (obs) => {
  eye.lastObs = obs;
  if (obs.found) {
    const now = performance.now();
    if (now - eye.lastFaceTime > 500) filter.reset(); // re-acquired: don't drag old state
    estimateEye(obs, settings, eye.raw);
    filter.filter(eye.raw, obs.t / 1000, eye.smoothed);
    eye.lastFaceTime = now;
    if (calib) {
      calib.samples.push({
        videoW: obs.videoW,
        videoH: obs.videoH,
        midY: obs.midY,
        pupilPx: effectivePupilPx(obs, settings),
      });
    }
  }
  if (settings.debug) drawCamOverlay(obs);
};

function drawCamOverlay(obs) {
  const w = obs.videoW, h = obs.videoH;
  if (camOverlay.width !== w || camOverlay.height !== h) {
    camOverlay.width = w;
    camOverlay.height = h;
  }
  const ctx = camOverlay.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!obs.found) return;
  const r = Math.max(3, w / 160);
  ctx.lineWidth = Math.max(2, w / 320);
  ctx.strokeStyle = '#7fd0ff';
  ctx.fillStyle = '#ffffff';
  for (const p of [obs.irisA, obs.irisB]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(obs.irisA.x, obs.irisA.y);
  ctx.lineTo(obs.irisB.x, obs.irisB.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(obs.midX, obs.midY, r, 0, Math.PI * 2);
  ctx.fill();
}

async function startCamera() {
  const introErr = $('introError');
  introErr.textContent = '';
  $('startBtn').disabled = true;
  $('cameraBtn').disabled = true;
  showStatus('Starting camera…');
  try {
    // Ask for the camera first (fast permission prompt), load the model in parallel.
    const modelP = tracker.loadModel((m) => m && showStatus(m));
    modelP.catch(() => {}); // handled below
    await tracker.startCamera();
    camWrap.classList.remove('nocam');
    showStatus('Loading face tracker…');
    await modelP;
    tracker.start();
    eye.mode = 'camera';
    intro.classList.add('hidden');
    $('cameraBtn').textContent = 'Stop camera';
    showStatus('Camera running — look at the screen.', '', 2500);
  } catch (e) {
    console.error(e);
    tracker.stop();
    camWrap.classList.add('nocam');
    const msg =
      e instanceof CameraError
        ? e.message
        : `Could not load the face tracker (${e && e.message ? e.message : e}). Check your network connection and reload.`;
    introErr.textContent = msg;
    showStatus(msg, 'error');
    if (!intro.classList.contains('hidden')) showStatus('');
  } finally {
    $('startBtn').disabled = false;
    $('cameraBtn').disabled = false;
  }
}

function stopCamera() {
  tracker.stop();
  eye.mode = 'mouse';
  camWrap.classList.add('nocam');
  $('cameraBtn').textContent = 'Start camera';
  showStatus('Camera stopped — mouse controls the eye position.', '', 3000);
}

function useMouse() {
  eye.mode = 'mouse';
  intro.classList.add('hidden');
  showStatus('Mouse mode: move the mouse to move your “head”, scroll to move closer/further.', '', 5000);
}

// Mouse fallback (handy for testing without a webcam).
canvas.addEventListener('pointermove', (e) => {
  if (eye.mode !== 'mouse') return;
  const nx = e.clientX / window.innerWidth - 0.5;
  const ny = e.clientY / window.innerHeight - 0.5;
  eye.mouse.x = nx * settings.screenW * 1.2;
  eye.mouse.y = -ny * settings.screenH * 1.6;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    if (eye.mode !== 'mouse') return;
    e.preventDefault();
    eye.mouse.z = Math.min(2, Math.max(0.2, eye.mouse.z * Math.exp(e.deltaY * 0.001)));
  },
  { passive: false }
);

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

function calibrate() {
  const st = $('calibStatus');
  if (eye.mode !== 'camera') {
    st.textContent = 'Start the camera first.';
    return;
  }
  const cm = parseFloat($('calibDist').value);
  if (!(cm > 10 && cm < 300)) {
    st.textContent = 'Enter a distance in cm (e.g. 60).';
    return;
  }
  st.textContent = 'Hold still, looking at the screen…';
  calib = { samples: [] };
  setTimeout(() => {
    const samples = calib.samples;
    calib = null;
    if (samples.length < 10) {
      st.textContent = 'No face seen — try again facing the webcam.';
      return;
    }
    const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
    const sample = { videoW: avg('videoW'), videoH: avg('videoH'), midY: avg('midY'), pupilPx: avg('pupilPx') };
    const fov = solveFovFromDistance(sample, cm / 100, settings);
    if (fov == null) {
      st.textContent = 'Could not solve — check the distance and webcam offsets.';
      return;
    }
    const rounded = Math.round(fov * 10) / 10;
    setSetting('camFov', rounded);
    filter.reset();
    st.textContent = `Webcam FOV set to ${rounded}° (from ${samples.length} frames).`;
  }, 1500);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch((e) => showStatus(`Fullscreen failed: ${e.message}`, 'warn', 3000));
  } catch (e) {
    showStatus('Fullscreen is not available here.', 'warn', 3000);
  }
}

function setPanelHidden(hidden) {
  panel.classList.toggle('hidden', hidden);
  document.body.classList.toggle('panel-hidden', hidden);
}

function cycle(key, options) {
  const ids = options.map(([v]) => v);
  const i = ids.indexOf(settings[key]);
  setSetting(key, ids[(i + 1) % ids.length]);
}

buildPanel();
document.body.classList.toggle('debug', settings.debug);

$('startBtn').addEventListener('click', startCamera);
$('mouseBtn').addEventListener('click', useMouse);
$('cameraBtn').addEventListener('click', () => (eye.mode === 'camera' ? stopCamera() : startCamera()));
$('calibBtn').addEventListener('click', calibrate);
$('fullscreenBtn').addEventListener('click', toggleFullscreen);
$('collapseBtn').addEventListener('click', () => panel.classList.toggle('collapsed'));
$('hideBtn').addEventListener('click', () => setPanelHidden(true));
$('showPanel').addEventListener('click', () => setPanelHidden(false));
$('resetBtn').addEventListener('click', () => {
  for (const d of DEFS) if (d.key) settings[d.key] = d.def;
  saveSettings();
  for (const k of Object.keys(inputs)) syncInput(k);
  filter.setStrength(settings.smoothing);
  document.body.classList.toggle('debug', settings.debug);
  rebuildScene();
  showStatus('Settings reset to defaults.', '', 2000);
});

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case 'h': setPanelHidden(!panel.classList.contains('hidden')); break;
    case 'f': toggleFullscreen(); break;
    case 'd': setSetting('debug', !settings.debug); break;
    case 's': cycle('stereo', STEREO_OPTIONS); break;
    case '1': setSetting('scene', 'grid'); break;
    case '2': setSetting('scene', 'objects'); break;
    case '3': setSetting('scene', 'ghost'); break;
    case 'c': eye.mouse.copy(DEFAULT_EYE); break;
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const eyeL = new THREE.Vector3();
const eyeR = new THREE.Vector3();
let lastT = performance.now();
let fps = 0, fpsCount = 0, fpsT0 = lastT;
let debugT = 0;

function updateEye(now, dt) {
  if (eye.mode === 'mouse') {
    eye.display.lerp(eye.mouse, 1 - Math.exp(-dt / 0.05));
    return;
  }
  const tracking = eye.mode === 'camera' && now - eye.lastFaceTime < 300;
  const target = tracking ? 1 : 0;
  eye.blend += (target - eye.blend) * (1 - Math.exp(-dt / 0.35));
  const b = eye.blend * eye.blend * (3 - 2 * eye.blend); // smoothstep
  eye.display.lerpVectors(DEFAULT_EYE, eye.smoothed, b);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  fpsCount++;
  if (now - fpsT0 > 1000) {
    fps = (fpsCount * 1000) / (now - fpsT0);
    fpsCount = 0;
    fpsT0 = now;
  }

  updateEye(now, dt);
  updateViewRect();
  if (current) current.update(now / 1000, dt);

  const e = eye.display;
  e.z = Math.max(e.z, 0.05);

  if (settings.stereo === 'off') {
    applyOffAxisProjection(camMono, viewRect, e, NEAR, FAR);
    renderer.setRenderTarget(null);
    renderer.render(scene, camMono);
  } else {
    const half = ((settings.ipdMm / 1000) * settings.eyeSep) / 2;
    const sign = settings.swapEyes ? -1 : 1;
    eyeL.set(e.x - half * sign, e.y, e.z);
    eyeR.set(e.x + half * sign, e.y, e.z);
    applyOffAxisProjection(camL, viewRect, eyeL, NEAR, FAR);
    applyOffAxisProjection(camR, viewRect, eyeR, NEAR, FAR);

    renderer.setRenderTarget(rtL);
    renderer.render(scene, camL);
    renderer.setRenderTarget(rtR);
    renderer.render(scene, camR);

    setMatrices(settings.stereo);
    composeMat.uniforms.gainL.value = 1 + settings.balance;
    composeMat.uniforms.gainR.value = 1 - settings.balance;
    renderer.setRenderTarget(null);
    renderer.render(composeScene, composeCam);
  }

  if (settings.debug && now - debugT > 100) {
    debugT = now;
    updateDebugText();
  }
}

function cm(v) {
  return (v * 100).toFixed(1).padStart(6);
}

function updateDebugText() {
  const o = eye.lastObs;
  const faceAge = performance.now() - eye.lastFaceTime;
  const lines = [];
  lines.push(`mode     ${eye.mode}${tracker.delegate ? ` (${tracker.delegate})` : ''}`);
  lines.push(`face     ${eye.mode === 'camera' ? (faceAge < 300 ? 'yes' : 'NO — easing to default') : '-'}`);
  lines.push(`fps      render ${fps.toFixed(0)}   track ${tracker.trackFps.toFixed(0)}`);
  lines.push(`eye cm   x${cm(eye.display.x)}  y${cm(eye.display.y)}  z${cm(eye.display.z)}`);
  if (eye.mode === 'camera') {
    lines.push(`raw cm   x${cm(eye.raw.x)}  y${cm(eye.raw.y)}  z${cm(eye.raw.z)}`);
    if (o && o.found) {
      lines.push(`pupils   ${o.pupilPx.toFixed(1)} px  yaw factor ${o.yawFactor.toFixed(2)}`);
      lines.push(`video    ${o.videoW}×${o.videoH}  fov ${settings.camFov}°`);
    }
  }
  const physAspect = settings.screenW / settings.screenH;
  const pxAspect = screen.width / screen.height;
  lines.push(`screen   ${screen.width}×${screen.height}px  aspect ${pxAspect.toFixed(2)} vs ${physAspect.toFixed(2)} set`);
  if (Math.abs(pxAspect - physAspect) / pxAspect > 0.05) lines.push('         ⚠ W/H aspect differs from the display');
  lines.push(
    `view m   ${viewInfo.xL.toFixed(3)}..${viewInfo.xR.toFixed(3)} × ${viewInfo.yB.toFixed(3)}..${viewInfo.yT.toFixed(3)}` +
      (isFullscreen() ? ' (fullscreen)' : viewInfo.corrected ? ' (window est.)' : '')
  );
  lines.push(`stereo   ${settings.stereo}  sep ${settings.eyeSep.toFixed(2)}  bal ${settings.balance.toFixed(2)}`);
  debugText.textContent = lines.join('\n');
}

onResize();
rebuildScene();
requestAnimationFrame(frame);

// For console debugging.
window.window3d = { settings, eye, tracker, renderer, scene };
