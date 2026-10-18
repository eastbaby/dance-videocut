"""Position-first pose tracking with bounded recovery for detector dropouts.

Every source frame is detected. A missing detection must not transfer the target
identity to a distant neighbour. Manual re-lock starts a new position anchor.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

import numpy as np
from statistics import median


def box_only(d):
    return {k: float(d[k]) for k in ('x', 'y', 'w', 'h')}


def center(b):
    return np.array([b['x'] + b['w'] / 2, b['y'] + b['h'] / 2])


def iou(a, b):
    w = max(0, min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x']))
    h = max(0, min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y']))
    area = w * h
    return area / max(1, a['w'] * a['h'] + b['w'] * b['h'] - area)


def collect_detections(input_path, model_path, emit, progress_max=80):
    import cv2
    stat = Path(input_path).stat()
    model_stat = Path(model_path).stat()
    signature = [str(Path(input_path).resolve()), stat.st_size, stat.st_mtime_ns,
                 str(Path(model_path).resolve()), model_stat.st_size, model_stat.st_mtime_ns, 'position-v3-pose1280-conf025']
    cache_dir = Path(tempfile.gettempdir()) / ('danceframe-tracking-' + str(os.getuid()))
    cache_dir.mkdir(mode=0o700, exist_ok=True)
    cache = cache_dir / (hashlib.sha256(json.dumps(signature).encode()).hexdigest() + '.json')
    try:
        data = json.loads(cache.read_text())
        if data['signature'] == signature and data['detections']:
            emit({'type': 'phase', 'message': '复用本地人物检测，正在重新锁定目标...'})
            emit({'type': 'progress', 'progress': progress_max})
            return data['detections']
    except (OSError, ValueError, KeyError, TypeError):
        pass
    emit({'type': 'phase', 'message': '正在加载模型并逐帧检测人物位置...'})
    from ultralytics import YOLO
    import torch
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    model = YOLO(str(model_path))
    cap = cv2.VideoCapture(input_path)
    total = max(1, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    detections = []
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            result = model(frame, verbose=False, imgsz=1280, conf=.25, device=device)[0]
            people = []
            for n, box in enumerate(result.boxes if result.boxes is not None else []):
                x1, y1, x2, y2 = box.xyxy[0].cpu().tolist()
                d = dict(x=x1, y=y1, w=x2-x1, h=y2-y1, confidence=float(box.conf[0]))
                if result.keypoints is not None:
                    d['keypoints'] = result.keypoints.data[n].cpu().tolist()
                people.append(d)
            detections.append(people)
            emit({'type': 'progress', 'progress': int(len(detections) / total * progress_max)})
    finally:
        cap.release()
    if not detections:
        raise ValueError('视频未读取到任何有效帧')
    # Atomic write: interrupted analysis cannot publish a partial cache.
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=cache_dir, delete=False) as f:
            json.dump(dict(signature=signature, detections=detections), f)
            name = f.name
        os.replace(name, cache)
    except OSError:
        pass  # Cache failure must not prevent tracking.
    return detections


def position_distance(a, b):
    """Median displacement of corresponding visible joints resists box jitter.

    A raised arm or crouch changes a box centre without moving the whole body.
    Require enough shared, confident joints; older detections use box centres.
    No clothing/lighting appearance descriptor participates in matching.
    """
    ka = np.asarray(a.get('keypoints', []), dtype=float)
    kb = np.asarray(b.get('keypoints', []), dtype=float)
    if ka.shape == (17, 3) and kb.shape == (17, 3):
        valid = (ka[:, 2] > .45) & (kb[:, 2] > .45)
        if valid.sum() >= 4:
            return float(np.median(np.linalg.norm(ka[valid, :2] - kb[valid, :2], axis=1)))
    return float(np.linalg.norm(center(a) - center(b)))


def associate(detections, init_frame, user_box, fps=30):
    """Position continuity with 100 ms grace and confirmed recovery up to 500 ms.

    Recovery keeps a bounded radius around the last reliable body. A candidate
    after a longer gap must persist in the next two frames; a distant neighbour
    never qualifies just because the target disappeared. Very long occlusions
    still need manual re-lock because position alone cannot establish identity.
    """
    if not detections:
        raise ValueError('视频未读取到任何有效帧')
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError('视频帧率无效')
    init_frame = min(len(detections)-1, max(0, init_frame))
    candidates = [d for d in detections[init_frame] if iou(d, user_box) > .05]
    if not candidates:
        raise ValueError('当前框内未检测到人物，请移到人物清晰可见的一帧，重新框选后再试。')
    seed = min(candidates, key=lambda d: float(np.linalg.norm(center(d)-center(user_box))))
    boxes = [None] * len(detections)
    boxes[init_frame] = box_only(seed)
    lost = []
    grace_frames = max(1, round(fps * .1))
    recovery_frames = max(grace_frames, round(fps * .5))
    base_radius = .20 * 30 / fps

    def rank(people, previous):
        return sorted([(position_distance(d, previous), n, d)
                       for n, d in enumerate(people)], key=lambda item: item[0])

    def ambiguous(ranked, scale):
        return len(ranked) > 1 and ranked[1][0] - ranked[0][0] < .025 * scale

    def confirmed(index, candidate, direction, scale):
        # Offline analysis can inspect future source frames without delaying UI.
        # Never accept a lone reappearance near the end of the available clip.
        for step in (1, 2):
            following = index + direction * step
            if not 0 <= following < len(detections):
                return False
            ranked = rank(detections[following], candidate)
            if not ranked or ranked[0][0] > scale * base_radius or ambiguous(ranked, scale):
                return False
            candidate = ranked[0][2]
        return True

    for direction in (1, -1):
        previous = seed
        heights = [seed['h']]
        misses = 0
        end = len(detections) if direction == 1 else -1
        for index in range(init_frame + direction, end, direction):
            # Half a second of body scale avoids a single partial box shrinking
            # the search radius until the person can never be acquired again.
            scale = max(1., median(heights))
            radius = scale * (base_radius + .09 * min(misses / grace_frames, 1.))
            ranked = rank(detections[index], previous)
            accepted = (misses <= recovery_frames and ranked and
                        ranked[0][0] <= radius and not ambiguous(ranked, scale))
            if accepted and misses > grace_frames:
                accepted = confirmed(index, ranked[0][2], direction, scale)
            if accepted:
                previous = ranked[0][2]
                heights = [*heights[-max(1, round(fps * .5)-1):], previous['h']]
                misses = 0
            else:
                misses += 1
                lost.append(index)
            boxes[index] = box_only(previous)
    return boxes, sorted(lost)
