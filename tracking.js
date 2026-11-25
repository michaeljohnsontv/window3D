// tracking.js — webcam + MediaPipe Face Landmarker, eye position estimate,
// One Euro smoothing.
//
// Everything runs locally in the browser. Video frames never leave the page;
// only the MediaPipe library, its WASM runtime and the face model are
// downloaded from their public CDNs.

const MEDIAPIPE_VERSION = '0.10.18';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Iris centre landmarks (present because the Face Landmarker model includes
// the iris refinement: 478 landmarks in total).
const IRIS_A = 468;
const IRIS_B = 473;

// ---------------------------------------------------------------------------
// One Euro filter (Casiez, Roussel & Vogel 2012)
// ---------------------------------------------------------------------------

function smoothingAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  constructor(minCutoff = 1, beta = 0, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  filter(value, tSeconds) {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.t = tSeconds;
      return value;
    }
    let dt = tSeconds - this.t;
    if (!(dt > 1e-4)) dt = 1 / 60;
    this.t = tSeconds;

    const rawDx = (value - this.x) / dt;
    const aD = smoothingAlpha(this.dCutoff, dt);
    this.dx = this.dx + aD * (rawDx - this.dx);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = smoothingAlpha(cutoff, dt);
    this.x = this.x + a * (value - this.x);
    return this.x;
  }
}

/** Map a 0..1 "smoothing strength" to One Euro parameters (units: metres). */
export function smoothingToParams(strength) {
  const s = Math.min(Math.max(strength, 0), 1);
  // minCutoff: 5 Hz (light) .. 0.1 Hz (heavy) — controls jitter at rest.
  const minCutoff = Math.pow(10, 0.7 - 1.7 * s);
  // beta: how quickly the cutoff opens up when the head moves fast.
  const beta = 40 * Math.pow(10, -1.3 * s);
  return { minCutoff, beta, dCutoff: 1 };
}

export class Vec3OneEuro {
  constructor() {
    this.fx = new OneEuroFilter();
    this.fy = new OneEuroFilter();
    this.fz = new OneEuroFilter();
  }
  setStrength(strength) {
    const p = smoothingToParams(strength);
    for (const f of [this.fx, this.fy, this.fz]) {
      f.minCutoff = p.minCutoff;
      f.beta = p.beta;
      f.dCutoff = p.dCutoff;
    }
    // Depth from pupil distance is noisier than X/Y; smooth it a bit more.
    this.fz.minCutoff *= 0.6;
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
  filter(v, tSeconds, out) {
    out.x = this.fx.filter(v.x, tSeconds);
    out.y = this.fy.filter(v.y, tSeconds);
    out.z = this.fz.filter(v.z, tSeconds);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Eye position estimate
// ---------------------------------------------------------------------------

/** Focal length in pixels from a horizontal field of view. */
export function focalPx(videoWidth, hfovDeg) {
  return videoWidth / 2 / Math.tan((hfovDeg * Math.PI) / 360);
}

/** Pupil distance in pixels, optionally corrected for head yaw. */
export function effectivePupilPx(obs, settings) {
  return settings.yawComp ? obs.pupilPx / obs.yawFactor : obs.pupilPx;
}

/**
 * Convert one face observation to an eye-midpoint position in screen
 * coordinates (metres).
 *
 * settings: camFov (deg), ipdMm, camX, camYTop, camZ, camTilt (deg, + = tilted
 * down), screenH, yawComp.
 */
export function estimateEye(obs, settings, out = { x: 0, y: 0, z: 0 }) {
  const ipd = settings.ipdMm / 1000;
  const f = focalPx(obs.videoW, settings.camFov);
  const dpx = Math.max(effectivePupilPx(obs, settings), 1);

  // Camera frame: x right in the image, y up, z = forward (toward viewer).
  const zc = (f * ipd) / dpx;
  const xc = ((obs.midX - obs.videoW / 2) * zc) / f;
  const yc = (-(obs.midY - obs.videoH / 2) * zc) / f;

  // Webcam pitched down by `tilt`: forward = (0,-sinθ,cosθ), up = (0,cosθ,sinθ).
  const th = (settings.camTilt * Math.PI) / 180;
  const yw = yc * Math.cos(th) - zc * Math.sin(th);
  const zw = yc * Math.sin(th) + zc * Math.cos(th);

  // The webcam faces the viewer, so image-right is world-left: mirror X.
  out.x = -xc + settings.camX;
  out.y = yw + settings.screenH / 2 + settings.camYTop;
  out.z = zw + settings.camZ;
  return out;
}

/**
 * Back-solve the webcam's horizontal FOV from a known eye-to-screen distance.
 * `sample` is an averaged observation: { videoW, videoH, midY, pupilPx(eff.) }.
 * Returns the FOV in degrees, or null if it can't be solved.
 */
export function solveFovFromDistance(sample, distanceM, settings) {
  const ipd = settings.ipdMm / 1000;
  const zw = distanceM - settings.camZ;
  const th = (settings.camTilt * Math.PI) / 180;
  const a = -(sample.midY - sample.videoH / 2); // pixels, up positive
  // zw = ipd/dpx * (a sinθ + f cosθ)  =>  f = (zw*dpx/ipd - a sinθ) / cosθ
  const f = ((zw * sample.pupilPx) / ipd - a * Math.sin(th)) / Math.cos(th);
  if (!(f > 1)) return null;
  const fov = (2 * Math.atan(sample.videoW / 2 / f) * 180) / Math.PI;
  if (!(fov > 10 && fov < 170)) return null;
  return fov;
}

// ---------------------------------------------------------------------------
// Webcam + Face Landmarker
// ---------------------------------------------------------------------------

// MediaPipe's WASM runtime prints harmless "INFO: ..." lines via console.error
// (e.g. "INFO: Created TensorFlow Lite XNNPACK delegate for CPU."). Drop just
// those so real errors stay visible.
let consoleFiltered = false;
function quietMediaPipeInfoLogs() {
  if (consoleFiltered) return;
  consoleFiltered = true;
  const orig = console.error.bind(console);
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('INFO:')) return;
    orig(...args);
  };
}

export class CameraError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.onResult = null; // (obs) => void
    this.lastTs = 0;
    this.lastVideoTime = -1;
    this.trackFps = 0;
    this._fpsCount = 0;
    this._fpsT0 = performance.now();
    this.delegate = null;
  }

  async startCamera() {
    if (!window.isSecureContext) {
      throw new CameraError(
        'insecure',
        'Webcam access needs HTTPS (or localhost). Open the GitHub Pages https:// URL.'
      );
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new CameraError('unsupported', 'This browser does not support webcam access (getUserMedia).');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
      });
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CameraError(
          'denied',
          'Camera permission was denied. Allow camera access for this site in the browser’s address bar, then reload.'
        );
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        throw new CameraError('notfound', 'No webcam was found. Plug one in (or enable it) and try again.');
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        throw new CameraError(
          'busy',
          'The webcam is in use by another application (Zoom, Teams, OBS…). Close it and try again.'
        );
      }
      throw new CameraError('other', `Could not start the webcam: ${name || ''} ${err && err.message ? err.message : err}`);
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    if (!this.video.videoWidth) {
      await new Promise((res) => this.video.addEventListener('loadedmetadata', res, { once: true }));
    }
  }

  async loadModel(onStatus = () => {}) {
    onStatus('Loading face tracker…');
    quietMediaPipeInfoLogs();
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU delegate unavailable, falling back to CPU.', e);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
    onStatus('');
  }

  start() {
    if (this.running) return;
    this.running = true;
    const v = this.video;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const cb = () => {
        if (!this.running) return;
        this._process();
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    } else {
      const loop = () => {
        if (!this.running) return;
        if (v.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = v.currentTime;
          this._process();
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  stop() {
    this.running = false;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }

  _process() {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || !v.videoWidth) return;
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 0.01; // must be strictly increasing
    this.lastTs = ts;

    let result;
    try {
      result = this.landmarker.detectForVideo(v, ts);
    } catch (e) {
      console.warn('Face detection error', e);
      return;
    }

    this._fpsCount++;
    const now = performance.now();
    if (now - this._fpsT0 > 1000) {
      this.trackFps = (this._fpsCount * 1000) / (now - this._fpsT0);
      this._fpsCount = 0;
      this._fpsT0 = now;
    }

    const W = v.videoWidth;
    const H = v.videoHeight;
    const obs = { found: false, t: ts, videoW: W, videoH: H };
    const lms = result && result.faceLandmarks && result.faceLandmarks[0];
    if (lms && lms.length > IRIS_B) {
      const a = lms[IRIS_A];
      const b = lms[IRIS_B];
      const ax = a.x * W, ay = a.y * H;
      const bx = b.x * W, by = b.y * H;
      obs.found = true;
      obs.irisA = { x: ax, y: ay };
      obs.irisB = { x: bx, y: by };
      obs.midX = (ax + bx) / 2;
      obs.midY = (ay + by) / 2;
      obs.pupilPx = Math.hypot(ax - bx, ay - by);

      // Head yaw foreshortens the eye-to-eye vector. The facial transformation
      // matrix's first column is the head's left-right axis in camera space;
      // its projected length onto the image plane gives the foreshortening.
      let yawFactor = 1;
      const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
      if (m && m.data && m.data.length >= 16) {
        const d = m.data;
        const len3 = Math.hypot(d[0], d[1], d[2]);
        if (len3 > 1e-6) yawFactor = Math.hypot(d[0], d[1]) / len3;
      }
      obs.yawFactor = Math.min(Math.max(yawFactor, 0.6), 1);
      obs.landmarks = lms;
    }
    if (this.onResult) this.onResult(obs);
  }
}
