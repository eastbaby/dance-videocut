# Local Engine Plan

Dance Videocut is moving toward a local Mac engine:

```text
video file
-> YOLO / YOLO-pose person detection
-> ByteTrack or BoT-SORT target identity tracking
-> RTMPose or YOLO-pose full-body keypoints
-> safe crop path smoothing
-> FFmpeg 9:16 MP4 export
```

## Mac M4 Recommendation

Start with the fast mode:

- `ultralytics` for YOLO pose or person detection
- `opencv-python` for frame IO and preview proxies
- `ffmpeg` for final video export
- `onnxruntime` or CoreML export later for Apple Silicon acceleration

Local prerequisites:

```bash
uv sync
```

`uv sync` installs the Python fallback `imageio-ffmpeg`, so MP4 export can work even before a system `ffmpeg` is installed. For the final packaged app, bundle a native FFmpeg binary.

On Apple Silicon, prefer an arm64 Python:

```bash
uv sync --python /usr/bin/python3
```

Tracking dependencies are optional for the next phase:

```bash
uv sync --extra tracking
```

Keep SAM2 as an advanced precision mode. It is useful for mask-level target tracking, but it is heavier than the first usable product needs.

## Product Modes

- Fast: YOLO-pose + simple ID tracking + FFmpeg.
- Precise: YOLO person + ByteTrack + RTMPose.
- Advanced: SAM2 assisted mask tracking + pose-based safe crop.

The Electron shell already exposes a diagnostics bridge for Python and FFmpeg. The next implementation step is to replace the browser fallback tracker with this local engine and stream progress back through IPC.

## Current position tracking and manual re-lock

`identity_tracking.py` is shared by analysis and the export fallback. YOLO-pose
runs on **every source frame at 1280 px inference resolution**, using MPS when
available and CPU otherwise. Association uses the median displacement of at
least four corresponding confident body joints. This tolerates swinging limbs
and box changes during crouches. It falls back to box-centre distance when
insufficient joints are visible; no clothing/colour descriptor is used.

A match must be within 20% of the recent median body height at 30 fps (the base
allowance scales inversely with fps). Scale history spans about half a second
so one partial detection cannot collapse the radius. After a miss, retain the
last reliable position; radius growth remains capped at another 9% of body
height. The first 100 ms can recover directly. Up to 500 ms, a returning candidate
must also match unambiguously in the next two frames in the tracking direction.
Near-ties hold position. Longer losses require manual re-lock: the search radius
never grows indefinitely and a lone late bystander is not enough to resume.
`uncertainFrames` reports held frames, including ambiguous detections. These are
heuristic limits, not a guarantee of identity through overlaps or long occlusions.

A complete detection pass is cached atomically in the user's OS temporary
directory, keyed by source/model path, size, modification time and detector
configuration. Only boxes, confidence and pose coordinates are cached, not frames or
appearance features. Re-lock reuses the pass. Dragging the target box re-associates from the
current decoded frame onward, preserving preceding trajectory and scale edits.
Failed/cancelled requests leave the old trajectory intact. Preview and export
use the same merged boxes.

`tests/fixtures/detection-dropout.json` captures an actual old-detector failure:
source frame 737 (zero-based) drops the target; the nearest remaining person is
441 px away. Frame 738 detects the original target again, only 23.2 px from its
last reliable centre. The old 1542 px gate switched identity; the new gate holds
one frame and recovers. The fixture contains coordinates only.

`six-frame-dropout.json` captures frames 208–223 of the current 4K dance clip:
the selected front dancer is absent for six consecutive low-resolution detections,
then returns nearby. `pose-crouch.json` covers a real high-resolution crouch and
arm-motion sequence where box centres alone stop tracking. Both use local
coordinates only.

Regression checks:

```bash
build/native-engine-venv-py312/bin/python tests/identity-tracking.py
node tests/relock.test.mjs
node tests/trajectory.test.mjs
node tests/keyframe-scale.test.mjs
npm run build
node_modules/.bin/electron tests/keyframe-preview.cjs
node tests/engine-runtime.cjs
build/native-engine-venv-py312/bin/python tests/export-audio.py
```
