# Window3D — head-tracked anaglyph "window" demo

A single static web page that turns a desktop monitor (designed for an ultrawide) into a 3D window. A webcam tracks the viewer's face, and the scene is re-rendered every frame with an **off-axis (asymmetric frustum) projection** from the viewer's eye position, so the screen behaves like a window into a 3D space. Optional **red-cyan anaglyph stereo** adds real pop-out depth with cheap paper/plastic 3D glasses.

It's a desk-sized prototype of a head-tracked mini-CAVE for a conference booth.

## Quick start

1. Open the GitHub Pages URL (HTTPS is required for the webcam).
2. Click **Start camera** and allow camera access. (Or **Try with mouse instead** to test without a webcam: move the mouse to move your "head", scroll to change distance.)
3. Press **F** for fullscreen. Set **Active width/height** to your screen's lit area (34" ultrawide ≈ 0.80 × 0.34 m).
4. Turn on **Show debug** (or press **D**) to see the webcam feed and the estimated eye position in cm.
5. Sit at a measured distance (e.g. 60 cm), type it under **Calibrate distance** and press **Calibrate**.
6. In **Grid room** with stereo **Off**, the room's opening should stay locked to the screen edges as you move.
7. Put on red (left) / cyan (right) glasses and switch to **Red-cyan (Dubois)**. Use the **Ghosting test** scene to tune eye separation and L/R brightness.

Keys: `H` panel · `F` fullscreen · `D` debug · `S` cycle stereo mode · `1` `2` `3` scenes · `C` recentre (mouse mode).

Settings are saved in `localStorage`.

## Files

```
index.html     page shell, settings panel, canvas, import map (pinned CDN versions)
main.js        app setup, render loop, UI wiring, anaglyph compositor
tracking.js    webcam + MediaPipe Face Landmarker, eye position estimate, One Euro smoothing
projection.js  off-axis projection maths (Kooima generalized perspective projection)
scenes.js      test scenes (grid room, floating objects, ghosting test)
```

No build step. Dependencies are loaded from jsDelivr, version-pinned: three.js `0.170.0`, `@mediapipe/tasks-vision` `0.10.18` (WASM from jsDelivr, face model from Google's model storage).

Run locally with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000` (localhost counts as a secure context, so the webcam works).

## How it works

### Coordinate system

Metres. Origin at the centre of the screen's lit area, +X right, +Y up, +Z out of the screen toward the viewer. The screen is `[-W/2, W/2] × [-H/2, H/2]` at `z = 0`; content behind the glass has negative Z.

### Eye position from the webcam

- Face Landmarker gives the two iris centres (landmarks 468 and 473).
- **Distance:** `z = f · IPD / pupilDistancePx`, with focal length `f = (videoWidth/2) / tan(HFOV/2)`. The pupil distance is corrected for head yaw using the face transformation matrix (toggle: *Head-turn compensation*).
- **X/Y:** the midpoint between the eyes is back-projected at that distance with the same `f`, X mirrored (the webcam faces you), optionally rotated by the webcam tilt, then offset by the webcam position (default centred, `y = H/2 + 1 cm`).
- **Smoothing:** One Euro filter per axis; the *Smoothing* slider maps to its min-cutoff and beta.
- If no face is seen for 0.3 s, the eye eases back to `(0, 0, 0.65)` m.
- **Calibrate distance** back-solves the webcam's horizontal FOV from 1.5 s of frames at a known distance.

### Off-axis projection

`projection.js` implements Kooima's generalized perspective projection from three screen corners. For the flat screen it reduces to a camera at the eye with no rotation and

```
left   = (-W/2 - eye.x) * n / eye.z      right = (W/2 - eye.x) * n / eye.z
bottom = (-H/2 - eye.y) * n / eye.z      top   = (H/2 - eye.y) * n / eye.z
```

written with `projectionMatrix.makePerspective(...)` every frame (never `updateProjectionMatrix()`). Because it takes arbitrary corners, a second screen at 90° only needs its own corners and camera.

When the page is **not fullscreen**, *Correct for window position* estimates which part of the physical screen the browser viewport covers (from `window.screenX/Y` and the window chrome size) so the window illusion still roughly holds. Fullscreen is exact.

### Stereo (anaglyph)

Two cameras at the tracked midpoint ± `IPD/2 × separation` along X, each with its own off-axis projection, rendered to half-float render targets and combined in a full-screen shader with 3×3 colour matrices (in linear light):

- **Red-cyan:** half-colour (left eye gets luminance in red, right eye gets green + blue).
- **Red-cyan (Dubois):** Dubois least-squares matrices; less ghosting. Default.
- **L/R brightness** scales the left/right contributions (`1 ± balance`) to compensate a dim/leaky red lens. **Swap eyes** if your glasses are the other way round.

## Acceptance checks

- [ ] Page loads on GitHub Pages with no console errors.
- [ ] Camera starts only after the button is clicked, and the debug view shows a stable eye position.
- [ ] In the grid room, mono mode: the room's opening stays aligned with the screen edges as the head moves left, right, up, down, closer and further.
- [ ] Moving the head reveals parts of the room's side walls (true parallax).
- [ ] Anaglyph mode with red-cyan glasses: objects in front of the screen appear to float in front of it.
- [ ] Ghosting is reduced with the Dubois mode and the balance slider.
- [ ] Settings survive a page reload.

## Troubleshooting

- **Room edges swim/slide when you move:** check the screen width/height, then calibrate distance. If left/right motion is too strong or weak, the FOV is off; if up/down is off, check *Y above top edge* and *Tilt*.
- **Depth feels inverted with glasses on:** tick *Swap eyes*.
- **Strong ghosting:** lower *Eye separation*, try the *Ghosting test* scene, and adjust *L/R brightness*.
- **Debug shows an aspect warning:** the W/H you typed doesn't match the display's pixel aspect — re-measure the lit area.

## Known limits

- One viewer only, since the view is rendered for one tracked face.
- Distance from the webcam is an estimate, so expect some depth scaling error until calibrated.
- Webcam tracking adds a little lag, so smooth head movements look best.
- Anaglyph distorts colour, and bright red or cyan content will flicker between eyes.

## Future

- Two screens at 90° (corner CAVE): `applyOffAxisProjection` already takes arbitrary screen corners; add a second screen definition and camera.
- Swap the webcam for a depth camera or IR marker tracking at the booth.
