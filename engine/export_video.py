#!/usr/bin/env python3
import json
import math
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import numpy as np
from identity_tracking import collect_detections, associate

ASPECTS = {
    "9:16": 9 / 16,
    "1:1": 1,
    "4:5": 4 / 5,
    "16:9": 16 / 9,
}

OUTPUT_SIZE = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "16:9": (1920, 1080),
}


def emit(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def bundled_resource_path(name):
    """Return a resource shipped alongside a PyInstaller executable."""
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return root / name


def local_ffmpeg_candidate():
    root = Path(__file__).resolve().parents[1]
    package_json = root / "node_modules" / "ffmpeg-static" / "package.json"
    if not package_json.exists():
        return None
    try:
        package = json.loads(package_json.read_text())
        relative_path = package.get("ffmpeg-static")
        if relative_path:
            candidate = root / "node_modules" / "ffmpeg-static" / relative_path
            if candidate.exists():
                return str(candidate)
    except Exception:
        pass
    for name in ("ffmpeg", "ffmpeg.exe"):
        candidate = root / "node_modules" / "ffmpeg-static" / name
        if candidate.exists():
            return str(candidate)
    return None


def clamp(value, low, high):
    return min(high, max(low, value))


def even(value):
    return max(2, int(math.floor(value / 2) * 2))


def crop_for_box(box, aspect, video_w, video_h, subject_scale):
    ratio = ASPECTS[aspect]
    scale = subject_scale / 100
    safe_w = box["w"] / scale
    safe_h = box["h"] / scale
    crop_w = max(safe_w, safe_h * ratio)
    crop_h = crop_w / ratio
    if crop_h < safe_h:
        crop_h = safe_h
        crop_w = crop_h * ratio
    crop_w = min(crop_w, video_w)
    crop_h = min(crop_h, video_h)
    if crop_w / crop_h < ratio:
        crop_h = crop_w / ratio
    if crop_w / crop_h > ratio:
        crop_w = crop_h * ratio
    center_x = box["x"] + box["w"] / 2
    center_y = box["y"] + box["h"] / 2
    x = clamp(center_x - crop_w / 2, 0, video_w - crop_w)
    y = clamp(center_y - crop_h / 2, 0, video_h - crop_h)
    return {
        "x": even(x),
        "y": even(y),
        "w": even(crop_w),
        "h": even(crop_h),
    }


def decode_audio_samples(ffmpeg, media_path, sample_rate=11025, max_seconds=240):
    command = [
        ffmpeg,
        "-v", "error",
        "-i", media_path,
        "-vn",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-t", str(max_seconds),
        "-f", "f32le",
        "-",
    ]
    process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.returncode != 0:
        error = process.stderr.decode("utf-8", errors="ignore").strip()
        raise RuntimeError(error or f"无法读取音频: {media_path}")
    if not process.stdout:
        raise RuntimeError(f"媒体文件没有可分析的音轨: {media_path}")
    samples = np.frombuffer(process.stdout, dtype=np.float32)
    if samples.size < sample_rate:
        raise RuntimeError(f"音频过短，无法稳定分析拍点: {media_path}")
    return np.nan_to_num(samples), sample_rate


def analyze_audio_beats(samples, sample_rate):
    samples = samples.astype(np.float32)
    samples = samples - float(np.mean(samples))
    peak = float(np.max(np.abs(samples)))
    if peak > 0:
        samples = samples / peak

    frame = 2048
    hop = 512
    if len(samples) < frame * 4:
        raise RuntimeError("音频长度不足，无法分析 BPM")

    frames = []
    for start in range(0, len(samples) - frame, hop):
        chunk = samples[start:start + frame]
        frames.append(float(np.sqrt(np.mean(chunk * chunk))))
    envelope = np.array(frames, dtype=np.float32)
    envelope = np.maximum(0, envelope - np.percentile(envelope, 20))
    if envelope.max() > 0:
        envelope = envelope / envelope.max()

    flux = np.maximum(0, np.diff(envelope, prepend=envelope[0]))
    smooth_kernel = np.ones(5, dtype=np.float32) / 5
    onset = np.convolve(flux, smooth_kernel, mode="same")
    if onset.max() > 0:
        onset = onset / onset.max()

    hop_seconds = hop / sample_rate
    min_bpm, max_bpm = 60, 200
    min_lag = max(1, int((60 / max_bpm) / hop_seconds))
    max_lag = min(len(onset) // 2, int((60 / min_bpm) / hop_seconds))
    if max_lag <= min_lag:
        raise RuntimeError("音频太短，无法估计 BPM")

    centered = onset - np.mean(onset)
    lag_scores = []
    for lag in range(min_lag, max_lag + 1):
        left = centered[:-lag]
        right = centered[lag:]
        denom = float(np.linalg.norm(left) * np.linalg.norm(right))
        score = float(np.dot(left, right) / denom) if denom > 0 else 0.0
        lag_scores.append((lag, score))

    best_lag, best_score = max(lag_scores, key=lambda item: item[1])
    interval = best_lag * hop_seconds
    bpm = 60 / interval if interval > 0 else 0

    threshold = float(np.median(onset) + np.std(onset) * 0.75)
    min_peak_gap = max(1, int(0.24 / hop_seconds))
    peak_indices = []
    last_peak = -min_peak_gap
    for i in range(1, len(onset) - 1):
        if i - last_peak < min_peak_gap:
            continue
        if onset[i] >= threshold and onset[i] >= onset[i - 1] and onset[i] > onset[i + 1]:
            peak_indices.append(i)
            last_peak = i

    first_peak = peak_indices[0] if peak_indices else int(np.argmax(onset[: max_lag]))
    first_beat = first_peak * hop_seconds
    duration = len(samples) / sample_rate
    grid_beats = []
    t = first_beat
    while t < duration and len(grid_beats) < 128:
        grid_beats.append(round(float(t), 3))
        t += interval

    confidence = clamp((best_score + 0.25) / 0.85, 0, 1)
    return {
        "bpm": round(float(bpm), 2),
        "firstBeat": round(float(first_beat), 3),
        "beats": grid_beats,
        "confidence": round(float(confidence), 3),
        "duration": round(float(duration), 3),
    }


def audio_match_feature(samples, sample_rate, hop_seconds=0.05):
    samples = samples.astype(np.float32)
    samples = samples - float(np.mean(samples))
    peak = float(np.max(np.abs(samples)))
    if peak > 0:
        samples = samples / peak

    frame = max(1024, int(sample_rate * 0.08))
    hop = max(256, int(sample_rate * hop_seconds))
    values = []
    for start in range(0, len(samples) - frame, hop):
        chunk = samples[start:start + frame]
        rms = float(np.sqrt(np.mean(chunk * chunk)))
        zcr = float(np.mean(np.abs(np.diff(np.signbit(chunk).astype(np.float32)))))
        values.append((rms, zcr))
    if len(values) < 16:
        raise RuntimeError("音频太短，无法做整段匹配")

    matrix = np.array(values, dtype=np.float32)
    rms = matrix[:, 0]
    zcr = matrix[:, 1]
    onset = np.maximum(0, np.diff(rms, prepend=rms[0]))

    def norm(v):
        v = v - np.mean(v)
        std = np.std(v)
        return v / std if std > 1e-6 else v

    feature = norm(onset) * 0.65 + norm(rms) * 0.25 + norm(zcr) * 0.10
    feature = np.convolve(feature, np.ones(3, dtype=np.float32) / 3, mode="same")
    return feature.astype(np.float32), hop / sample_rate


def chroma_match_feature(samples, sample_rate, nfft=4096, hop=256):
    samples = samples.astype(np.float32)
    samples = samples - float(np.mean(samples))
    peak = float(np.max(np.abs(samples)))
    if peak > 0:
        samples = samples / peak
    if len(samples) < nfft * 4:
        raise RuntimeError("音频太短，无法做旋律匹配")

    window = np.hanning(nfft).astype(np.float32)
    freqs = np.fft.rfftfreq(nfft, 1 / sample_rate)
    valid = np.where((freqs >= 80) & (freqs <= 4000))[0]
    midi = np.round(69 + 12 * np.log2(freqs[valid] / 440.0)).astype(int)
    pitch_classes = ((midi % 12) + 12) % 12

    frames = []
    for start in range(0, len(samples) - nfft, hop):
        spectrum = np.abs(np.fft.rfft(samples[start:start + nfft] * window))
        chroma = np.zeros(12, dtype=np.float32)
        for idx, bin_idx in enumerate(valid):
            chroma[pitch_classes[idx]] += math.log1p(float(spectrum[bin_idx]))
        norm = float(np.linalg.norm(chroma))
        if norm > 1e-6:
            chroma = chroma / norm
        frames.append(chroma)

    feature = np.array(frames, dtype=np.float32).T
    return feature, hop / sample_rate


def top_alignment_for_features(source_feature, replacement_feature, hop_seconds, min_overlap_ratio=0.35):
    source_frames = source_feature.shape[-1]
    replacement_frames = replacement_feature.shape[-1]
    max_positive_delay = int(8 / hop_seconds)
    min_lag = -replacement_frames + max(10, int(source_frames * 0.25))
    best = {"offset": 0.0, "score": -1.0, "overlap": 0}

    for lag in range(min_lag, max_positive_delay + 1):
        source_start = max(0, lag)
        replacement_start = max(0, -lag)
        overlap = min(source_frames - source_start, replacement_frames - replacement_start)
        if overlap < max(20, int(source_frames * min_overlap_ratio)):
            continue

        a = source_feature[..., source_start:source_start + overlap].reshape(-1)
        b = replacement_feature[..., replacement_start:replacement_start + overlap].reshape(-1)
        a = a - np.mean(a)
        b = b - np.mean(b)
        denom = float(np.linalg.norm(a) * np.linalg.norm(b))
        score = float(np.dot(a, b) / denom) if denom > 0 else -1.0
        weighted_score = score * min(1.0, overlap / max(1, source_frames))
        if weighted_score > best["score"]:
            best = {
                "offset": lag * hop_seconds,
                "score": weighted_score,
                "overlap": overlap,
            }

    if best["score"] < -0.5:
        raise RuntimeError("无法找到可靠的音频匹配点")
    return best


def onset_detail_feature(samples, sample_rate, hop_seconds=0.01, frame_seconds=0.04):
    samples = samples.astype(np.float32)
    samples = samples - float(np.mean(samples))
    peak = float(np.max(np.abs(samples)))
    if peak > 0:
        samples = samples / peak

    frame = max(256, int(sample_rate * frame_seconds))
    hop = max(64, int(sample_rate * hop_seconds))
    if len(samples) < frame * 4:
        raise RuntimeError("音频太短，无法精修对齐")

    rms_values = []
    for start in range(0, len(samples) - frame, hop):
        chunk = samples[start:start + frame]
        rms_values.append(float(np.sqrt(np.mean(chunk * chunk))))

    rms = np.array(rms_values, dtype=np.float32)
    rms = np.maximum(0, rms - np.percentile(rms, 15))
    onset = np.maximum(0, np.diff(rms, prepend=rms[0]))

    def norm(v):
        v = v - np.mean(v)
        std = np.std(v)
        return v / std if std > 1e-6 else v

    detail = norm(onset) * 0.8 + norm(rms) * 0.2
    detail = np.convolve(detail, np.ones(5, dtype=np.float32) / 5, mode="same")
    return detail[np.newaxis, :].astype(np.float32), hop / sample_rate


def refine_alignment_offset(source_samples, source_sr, replacement_samples, replacement_sr, coarse_offset, radius_seconds=1.0):
    source_feature, source_hop = onset_detail_feature(source_samples, source_sr)
    replacement_feature, replacement_hop = onset_detail_feature(replacement_samples, replacement_sr)
    if abs(source_hop - replacement_hop) > 0.003:
        return {
            "offset": coarse_offset,
            "score": 0.0,
            "improvement": 0.0,
        }

    hop_seconds = source_hop
    source_frames = source_feature.shape[-1]
    replacement_frames = replacement_feature.shape[-1]
    coarse_lag = int(round(coarse_offset / hop_seconds))
    radius = max(1, int(radius_seconds / hop_seconds))
    best = {"offset": coarse_offset, "score": -1.0, "overlap": 0}

    for lag in range(coarse_lag - radius, coarse_lag + radius + 1):
        source_start = max(0, lag)
        replacement_start = max(0, -lag)
        overlap = min(source_frames - source_start, replacement_frames - replacement_start)
        if overlap < max(100, int(source_frames * 0.65)):
            continue
        a = source_feature[..., source_start:source_start + overlap].reshape(-1)
        b = replacement_feature[..., replacement_start:replacement_start + overlap].reshape(-1)
        a = a - np.mean(a)
        b = b - np.mean(b)
        denom = float(np.linalg.norm(a) * np.linalg.norm(b))
        score = float(np.dot(a, b) / denom) if denom > 0 else -1.0
        if score > best["score"]:
            best = {
                "offset": lag * hop_seconds,
                "score": score,
                "overlap": overlap,
            }
    if best["score"] < -0.5:
        return {
            "offset": coarse_offset,
            "score": 0.0,
            "improvement": 0.0,
        }
    best["improvement"] = best["offset"] - coarse_offset
    return best


def estimate_alignment_offset(source_samples, source_sr, replacement_samples, replacement_sr):
    source_chroma, source_hop = chroma_match_feature(source_samples, source_sr)
    replacement_chroma, replacement_hop = chroma_match_feature(replacement_samples, replacement_sr)
    if abs(source_hop - replacement_hop) > 0.005:
        raise RuntimeError("内部音频采样步长不一致")

    chroma_best = top_alignment_for_features(source_chroma, replacement_chroma, source_hop)
    if chroma_best["score"] >= 0.45:
        refined = refine_alignment_offset(
            source_samples,
            source_sr,
            replacement_samples,
            replacement_sr,
            chroma_best["offset"],
        )
        chroma_best["coarseOffset"] = chroma_best["offset"]
        chroma_best["offset"] = refined["offset"]
        chroma_best["refineScore"] = refined["score"]
        chroma_best["refineDelta"] = refined["improvement"]
        chroma_best["method"] = "chroma+onset-refine"
        return chroma_best

    source_onset, onset_hop = audio_match_feature(source_samples, source_sr)
    replacement_onset, replacement_onset_hop = audio_match_feature(replacement_samples, replacement_sr)
    if abs(onset_hop - replacement_onset_hop) > 0.005:
        raise RuntimeError("内部音频采样步长不一致")
    onset_best = top_alignment_for_features(source_onset[np.newaxis, :], replacement_onset[np.newaxis, :], onset_hop)
    onset_best["method"] = "onset"
    return onset_best


def main():
    if "--version" in sys.argv:
        print("DanceFrame Engine 1.0.6")
        return 0

    job = json.loads(sys.stdin.read())
    ffmpeg = os.environ.get("FFMPEG_PATH") or local_ffmpeg_candidate() or shutil.which("ffmpeg")
    if not ffmpeg:
        try:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            ffmpeg = None
    if not ffmpeg:
        try:
            import imageio_ffmpeg
            package_dir = Path(imageio_ffmpeg.__file__).parent
            candidates = sorted((package_dir / "binaries").glob("ffmpeg-*"))
            ffmpeg = str(candidates[0]) if candidates else None
        except Exception:
            ffmpeg = None
    if not ffmpeg:
        emit({"type": "error", "message": "未检测到 ffmpeg。请先运行 uv sync，或用 brew install ffmpeg 安装系统 FFmpeg。"})
        return 2

    # Parse job parameters
    input_path = job.get("inputPath")
    output_path = job.get("outputPath")
    aspect = job.get("aspect", "9:16")
    subject_scale = job.get("subjectScale", 62)
    smoothing_factor = job.get("smoothing", 78)
    current_time = job.get("currentTime", 0.0)
    user_box = job.get("box")
    mode = job.get("mode", "export")  # "track" or "export"
    precomputed_boxes = job.get("boxes")  # list of dicts, optional
    replacement_audio_path = job.get("replacementAudioPath")
    replacement_audio_offset = float(job.get("replacementAudioOffset") or 0.0)
    source_playback_rate = clamp(float(job.get("sourcePlaybackRate") or 1.0), 0.5, 2.0)

    if not input_path:
        emit({"type": "error", "message": "缺少必要的参数 inputPath"})
        return 2

    if mode == "beat":
        if not replacement_audio_path:
            emit({"type": "error", "message": "缺少替换音乐文件 replacementAudioPath"})
            return 2
        try:
            emit({"type": "phase", "message": "正在用 FFmpeg 解码源视频音轨..."})
            source_samples, source_sr = decode_audio_samples(ffmpeg, input_path)
            emit({"type": "phase", "message": "正在用 FFmpeg 解码替换音乐..."})
            replacement_samples, replacement_sr = decode_audio_samples(ffmpeg, replacement_audio_path)
            emit({"type": "phase", "message": "正在估计 BPM 和整段对齐位置..."})
            source = analyze_audio_beats(source_samples, source_sr)
            replacement = analyze_audio_beats(replacement_samples, replacement_sr)
            alignment = estimate_alignment_offset(source_samples, source_sr, replacement_samples, replacement_sr)
            rate = 1.0
            offset = alignment["offset"]
            emit({
                "type": "done",
                "source": source,
                "replacement": replacement,
                "offset": round(float(offset), 3),
                "rate": round(float(rate), 4),
                "alignmentScore": round(float(alignment["score"]), 3),
                "coarseOffset": round(float(alignment.get("coarseOffset", offset)), 3),
                "refineDelta": round(float(alignment.get("refineDelta", 0.0)), 3),
                "refineScore": round(float(alignment.get("refineScore", 0.0)), 3),
            })
            return 0
        except Exception as e:
            emit({"type": "error", "message": f"节拍分析失败: {str(e)}"})
            return 2

    try:
        import cv2
    except Exception as e:
        emit({"type": "error", "message": f"未检测到 OpenCV，无法进行视频追踪或导出: {str(e)}"})
        return 2

    # Open Video to inspect and extract parameters
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        emit({"type": "error", "message": f"无法打开输入视频: {input_path}"})
        return 2

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    video_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    video_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    if total_frames <= 0 or fps <= 0:
        emit({"type": "error", "message": "视频的帧率或总帧数检测异常"})
        return 2

    # ==================== MODE 1: TRACKING ONLY ====================
    if mode == "track":
        if not user_box:
            emit({"type": "error", "message": "缺少初始追踪框 box"})
            return 2

        try:
            all_detections = collect_detections(input_path, bundled_resource_path("yolov8n-pose.pt"), emit)
            init_frame = min(len(all_detections) - 1, max(0, int(current_time * fps + 0.5)))
            target_boxes, uncertain_frames = associate(all_detections, init_frame, user_box, fps)
        except Exception as e:
            emit({"type": "error", "message": f"人物追踪失败: {e}"})
            return 2

        # Smooth the trajectory using bidirectional Gaussian filter
        emit({"type": "phase", "message": "正在优化平滑镜头轨迹..."})
        coords = np.array([[b["x"], b["y"], b["w"], b["h"]] for b in target_boxes], dtype=np.float32)

        s_factor = float(smoothing_factor)
        window_size = int(5 + (s_factor / 92.0) * 56)
        if window_size % 2 == 0:
            window_size += 1
        sigma = 2.0 + (s_factor / 92.0) * 18.0

        half = window_size // 2
        kernel = np.exp(-np.arange(-half, half + 1) ** 2 / (2 * sigma ** 2))
        kernel /= kernel.sum()

        N = len(coords)
        smoothed_coords = np.zeros_like(coords)
        for i in range(N):
            start = i - half
            end = i + half + 1
            k_start = max(0, -start)
            k_end = len(kernel) - max(0, end - N)
            c_start = max(0, start)
            c_end = min(N, end)

            w = kernel[k_start:k_end]
            w_sum = w.sum()
            if w_sum > 0:
                w = w / w_sum
            else:
                w = np.ones(c_end - c_start) / (c_end - c_start)

            smoothed_coords[i] = np.sum(coords[c_start:c_end] * w[:, np.newaxis], axis=0)

        smoothed_boxes = []
        for sb in smoothed_coords:
            smoothed_boxes.append({
                "x": float(sb[0]),
                "y": float(sb[1]),
                "w": float(sb[2]),
                "h": float(sb[3])
            })

        emit({"type": "progress", "progress": 100})
        emit({"type": "done", "fps": float(fps), "boxes": target_boxes if job.get("rawTrajectory") else smoothed_boxes, "uncertainFrames": uncertain_frames})
        return 0

    # ==================== MODE 2: EXPORT RENDERING ====================
    elif mode == "export":
        if not output_path:
            emit({"type": "error", "message": "缺少输出视频路径 outputPath"})
            return 2

        render_boxes = []
        is_full_video_box = (
            user_box and
            abs(user_box.get("x", 0)) < 1e-3 and
            abs(user_box.get("y", 0)) < 1e-3 and
            abs(user_box.get("w", 0) - video_w) < 1.0 and
            abs(user_box.get("h", 0) - video_h) < 1.0
        )
        # If frontend sent pre-computed boxes, use them directly
        if precomputed_boxes:
            emit({"type": "phase", "message": "读取预计算轨迹进行视频裁剪..."})
            render_boxes = precomputed_boxes
        elif is_full_video_box or job.get("static") or not user_box:
            box_to_repeat = user_box if user_box else {"x": 0, "y": 0, "w": video_w, "h": video_h}
            emit({"type": "phase", "message": "使用静态镜头进行视频导出..."})
            render_boxes = [box_to_repeat] * total_frames
        else:
            # Use the same identity association as preview, including cached detections.
            try:
                all_detections = collect_detections(input_path, bundled_resource_path("yolov8n-pose.pt"), emit, 35)
                init_frame = min(len(all_detections) - 1, max(0, int(current_time * fps + 0.5)))
                target_boxes, _ = associate(all_detections, init_frame, user_box, fps)
            except Exception as e:
                emit({"type": "error", "message": f"人物追踪失败: {e}"})
                return 2

            coords = np.array([[b["x"], b["y"], b["w"], b["h"]] for b in target_boxes], dtype=np.float32)

            s_factor = float(smoothing_factor)
            window_size = int(5 + (s_factor / 92.0) * 56)
            if window_size % 2 == 0:
                window_size += 1
            sigma = 2.0 + (s_factor / 92.0) * 18.0

            half = window_size // 2
            kernel = np.exp(-np.arange(-half, half + 1) ** 2 / (2 * sigma ** 2))
            kernel /= kernel.sum()

            N = len(coords)
            smoothed_coords = np.zeros_like(coords)
            for i in range(N):
                start = i - half
                end = i + half + 1
                k_start = max(0, -start)
                k_end = len(kernel) - max(0, end - N)
                c_start = max(0, start)
                c_end = min(N, end)

                w = kernel[k_start:k_end]
                w_sum = w.sum()
                if w_sum > 0:
                    w = w / w_sum
                else:
                    w = np.ones(c_end - c_start) / (c_end - c_start)

                smoothed_coords[i] = np.sum(coords[c_start:c_end] * w[:, np.newaxis], axis=0)

            render_boxes = []
            for sb in smoothed_coords:
                render_boxes.append({
                    "x": float(sb[0]),
                    "y": float(sb[1]),
                    "w": float(sb[2]),
                    "h": float(sb[3])
                })

        # Render cropped frames and pipe to FFmpeg
        emit({"type": "phase", "message": "正在应用镜头并生成 MP4..."})
        output_w, output_h = OUTPUT_SIZE[aspect]
        N = len(render_boxes)
        output_frame_count = max(1, int(round(N / source_playback_rate)))
        output_duration = output_frame_count / fps

        cap = cv2.VideoCapture(input_path)
        if not cap.isOpened():
            emit({"type": "error", "message": "无法再次打开视频文件进行渲染"})
            return 2

        command = [
            ffmpeg,
            "-y",
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "-s", f"{output_w}x{output_h}",
            "-r", f"{fps:.3f}",
            "-i", "-",
        ]

        if replacement_audio_path:
            if not Path(replacement_audio_path).exists():
                emit({"type": "error", "message": f"替换音乐不存在: {replacement_audio_path}"})
                return 2

            audio_filters = []
            audio_input_path = replacement_audio_path
            if replacement_audio_offset < 0:
                command.extend(["-ss", f"{abs(replacement_audio_offset):.3f}"])
            command.extend(["-i", audio_input_path])

            filter_chain = "[1:a]"
            if replacement_audio_offset > 0:
                delay_ms = int(replacement_audio_offset * 1000)
                filter_chain += f"adelay={delay_ms}:all=1,"
            filter_chain += f"asetpts=PTS-STARTPTS,atrim=0:{max(0.1, output_duration):.3f}[aout]"
            audio_filters.extend(["-filter_complex", filter_chain])

            command.extend([
                *audio_filters,
                "-map", "0:v",
                "-map", "[aout]",
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-profile:v", "high",
                "-level", "4.1",
                "-preset", "medium",
                "-crf", "18",
                "-c:a", "aac",
                "-b:a", "192k",
                "-t", f"{output_duration:.3f}",
                "-movflags", "+faststart",
                output_path,
            ])
        else:
            # FFmpeg is bundled; ffprobe is not. Inspect stream headers without decoding.
            probe = subprocess.run([ffmpeg, "-hide_banner", "-i", input_path],
                                   capture_output=True, text=True, timeout=30)
            has_source_audio = bool(re.search(r"Stream #.*Audio:", probe.stderr))
            if has_source_audio:
                source_audio_filter = f"[1:a]atempo={source_playback_rate:.6f},asetpts=PTS-STARTPTS,atrim=0:{max(0.1, output_duration):.3f}[aout]"
                command.extend(["-i", input_path, "-filter_complex", source_audio_filter,
                                "-map", "0:v", "-map", "[aout]"])
            else:
                command.extend(["-map", "0:v", "-an"])
            command.extend([
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-profile:v", "high",
                "-level", "4.1",
                "-preset", "medium",
                "-crf", "18",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                output_path,
            ])

        # Electron supplies a writable directory outside the installed app.
        # Direct source runs keep diagnostics under the project root.
        try:
            default_root = (Path.home() / ".dance-videocut" if getattr(sys, "frozen", False)
                            else Path(__file__).resolve().parent.parent)
            log_dir = Path(os.environ.get("DANCE_VIDEOCUT_LOG_DIR") or default_root / ".logs")
            log_dir.mkdir(parents=True, exist_ok=True)
            (log_dir / "ffmpeg_command.log").write_text(" ".join(command) + "\n", encoding="utf-8")
        except OSError:
            pass  # Diagnostic failures must not prevent export.

        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=10 ** 7
        )

        frame_idx = 0
        source_frame_idx = 0
        source_frame = None
        start_progress = 35 if not precomputed_boxes else 0
        progress_range = 65 if not precomputed_boxes else 100

        while frame_idx < output_frame_count:
            target_source_idx = min(N - 1, int(frame_idx * source_playback_rate))
            while source_frame_idx <= target_source_idx:
                ret, frame = cap.read()
                if not ret:
                    break
                source_frame = frame
                source_frame_idx += 1

            if source_frame is None:
                break

            box = render_boxes[target_source_idx]
            crop = crop_for_box(box, aspect, video_w, video_h, subject_scale)

            x1 = clamp(int(crop["x"]), 0, video_w)
            y1 = clamp(int(crop["y"]), 0, video_h)
            x2 = clamp(x1 + int(crop["w"]), 0, video_w)
            y2 = clamp(y1 + int(crop["h"]), 0, video_h)

            if x2 - x1 < 10 or y2 - y1 < 10:
                cropped = source_frame
            else:
                cropped = source_frame[y1:y2, x1:x2]

            resized = cv2.resize(cropped, (output_w, output_h), interpolation=cv2.INTER_LANCZOS4)

            try:
                assert process.stdin is not None
                process.stdin.write(resized.tobytes())
            except IOError as e:
                stderr = process.stderr.read().decode("utf-8") if process.stderr else ""
                emit({"type": "error", "message": f"FFmpeg 写入管道断开: {stderr or str(e)}"})
                cap.release()
                return 2

            frame_idx += 1
            export_progress = start_progress + int((frame_idx / output_frame_count) * progress_range)
            emit({"type": "progress", "progress": export_progress})

        cap.release()
        
        if process.stdin:
            process.stdin.close()

        stderr = process.stderr.read().decode("utf-8") if process.stderr else ""
        code = process.wait()

        if code != 0:
            emit({"type": "error", "message": f"FFmpeg 编码失败: {stderr}"})
            return code

        emit({"type": "progress", "progress": 100})
        emit({"type": "done", "outputPath": output_path})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
