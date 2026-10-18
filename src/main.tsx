import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BadgeCheck,
  Cpu,
  Clapperboard,
  Download,
  Film,
  Focus,
  HardDrive,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  UserRoundSearch,
  WandSparkles,
  Tv,
  Trash2,
  FolderOpen,
  AudioWaveform,
  Volume2,
  VolumeX
} from "lucide-react";
import "./styles.css";
import { smoothTrajectory } from "./trajectory";
import { mergeRelock, retirePositionKeys, positionKeysAt } from "./relock";
import { frameAt, scaleAt, boxAtScale } from "./keyframe-scale";

type Aspect = "9:16" | "1:1" | "4:5" | "16:9";
type Box = { x: number; y: number; w: number; h: number };
type Keyframe = { time: number; box: Box; source: "ai" | "manual"; subjectScale?: number; position?: boolean; positionEnd?: number };
type BeatAnalysis = { bpm: number; firstBeat: number; beats: number[]; confidence: number; duration?: number };
type BeatMatch = { source: BeatAnalysis; replacement: BeatAnalysis; offset: number; rate: number };
type InspectorTab = "video" | "audio";
const SOURCE_SPEED_PRESETS = [0.75, 0.8, 0.9, 1] as const;

const ASPECTS: Record<Aspect, number> = {
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5,
  "16:9": 16 / 9
};

const EXPORT_SIZE: Record<Aspect, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "16:9": { w: 1920, h: 1080 }
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function cropForBox(box: Box, aspect: Aspect, videoW: number, videoH: number, subjectScale: number): Box {
  const ratio = ASPECTS[aspect];
  const scale = subjectScale / 100;
  const safeW = box.w / scale;
  const safeH = box.h / scale;
  let cropW = Math.max(safeW, safeH * ratio);
  let cropH = cropW / ratio;
  if (cropH < safeH) {
    cropH = safeH;
    cropW = cropH * ratio;
  }
  cropW = Math.min(cropW, videoW);
  cropH = Math.min(cropH, videoH);
  if (cropW / cropH < ratio) cropH = cropW / ratio;
  if (cropW / cropH > ratio) cropW = cropH * ratio;
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const x = clamp(center.x - cropW / 2, 0, videoW - cropW);
  const y = clamp(center.y - cropH / 2, 0, videoH - cropH);
  return { x, y, w: cropW, h: cropH };
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00.00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
}

interface EngineDiagnostics {
  python: string;
  ffmpeg: string;
  accelerator: string;
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const replacementAudioRef = useRef<HTMLAudioElement | null>(null);
  const videoFrameRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastDrawAtRef = useRef(0);
  const modeRef = useRef<"select" | "track">("select");
  const isDraggingRef = useRef(false);

  const [videoUrl, setVideoUrl] = useState("");
  const [videoPath, setVideoPath] = useState("");
  const [fileName, setFileName] = useState("");
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [subjectScale, setSubjectScale] = useState(62);
  const [scaleScope, setScaleScope] = useState<"global" | "keyframe">("keyframe");
  const [smoothing, setSmoothing] = useState(78);
  const [mode, setMode] = useState<"select" | "track">("select");
  const [manualBox, setManualBox] = useState<Box | null>(null);
  const [trackedBox, setTrackedBox] = useState<Box | null>(null);
  const [cropBox, setCropBox] = useState<Box | null>(null);
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [status, setStatus] = useState("请先导入一个跳舞视频。");
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [nativeOutputPath, setNativeOutputPath] = useState("");
  const [replacementAudioUrl, setReplacementAudioUrl] = useState("");
  const [replacementAudioPath, setReplacementAudioPath] = useState("");
  const [replacementAudioName, setReplacementAudioName] = useState("");
  const [beatMatch, setBeatMatch] = useState<BeatMatch | null>(null);
  const [audioOffset, setAudioOffset] = useState(0);
  const [sourcePlaybackRate, setSourcePlaybackRate] = useState(1);
  const [sourceMuted, setSourceMuted] = useState(false);
  const [replacementMuted, setReplacementMuted] = useState(false);
  const [sourceVolume, setSourceVolume] = useState(0.9);
  const [replacementVolume, setReplacementVolume] = useState(0.9);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("video");
  const [isAnalyzingBeat, setIsAnalyzingBeat] = useState(false);
  const sourceMutedRef = useRef(sourceMuted);
  const replacementMutedRef = useRef(replacementMuted);
  const sourcePlaybackRateRef = useRef(sourcePlaybackRate);

  // AI precomputation states
  const [rawBoxes, setRawBoxes] = useState<Box[]>([]);
  const [trackingBreaks, setTrackingBreaks] = useState<number[]>([]);
  const precomputedBoxes = useMemo(() => smoothTrajectory(rawBoxes, smoothing, trackingBreaks), [rawBoxes, smoothing, trackingBreaks]);
  const hasTracking = rawBoxes.length > 0;

  const [backendFps, setBackendFps] = useState(30.0);
  const [isTrackingBackend, setIsTrackingBackend] = useState(false);
  const [trackProgress, setTrackProgress] = useState(0);
  const editingLocked = isTrackingBackend || exporting;

  const outputSize = useMemo(() => EXPORT_SIZE[aspect], [aspect]);
  const isDesktop = Boolean(window.danceframe);

  const setSourceMonitorMuted = useCallback((muted: boolean) => {
    sourceMutedRef.current = muted;
    setSourceMuted(muted);
    if (videoRef.current) videoRef.current.muted = muted;
  }, []);

  const setReplacementMonitorMuted = useCallback((muted: boolean) => {
    replacementMutedRef.current = muted;
    setReplacementMuted(muted);
    const audio = replacementAudioRef.current;
    if (!audio) return;

    if (muted) {
      audio.pause();
      audio.muted = true;
    } else {
      audio.muted = false;
    }
  }, []);

  // Fetch diagnostics on load
  useEffect(() => {
    window.danceframe?.diagnostics().then(setDiagnostics).catch(() => {
      setDiagnostics(null);
    });
  }, []);

  // Set up IPC progress listeners
  useEffect(() => {
    return window.danceframe?.onEngineProgress((message) => {
      if (message.type === "phase") {
        setStatus(message.message);
      }
      if (message.type === "progress") {
        if (isTrackingBackend) {
          setTrackProgress(message.progress);
        } else if (exporting) {
          setExportProgress(message.progress);
        }
      }
      if (message.type === "done") {
        if (exporting) {
          setNativeOutputPath(message.outputPath);
          setStatus(`视频导出成功！保存至：${message.outputPath}`);
        }
      }
      if (message.type === "error") {
        setStatus(`发生错误: ${message.message}`);
      }
    });
  }, [isTrackingBackend, exporting]);

  // Motion path warping algorithm: Blends manual keyframes into AI precomputed trajectory
  const getBoxForFrame = useCallback(
    (frameIdx: number) => {
      if (!precomputedBoxes || precomputedBoxes.length === 0) {
        return manualBox;
      }

      const totalFrames = precomputedBoxes.length;
      const baseBox = precomputedBoxes[clamp(frameIdx, 0, totalFrames - 1)];
      if (!baseBox) return { x: 0, y: 0, w: videoSize.w, h: videoSize.h };

      // If no manual adjustments are present, return YOLO output directly
      const positionKeys = positionKeysAt(keyframes, frameIdx);
      if (positionKeys.length === 0) {
        return baseBox;
      }

      // Convert keyframe timestamps to frame indices and sort them
      const sortedKeyframes = [...positionKeys]
        .map((k) => ({
          frameIdx: frameAt(k.time, backendFps),
          box: k.box
        }))
        .sort((a, b) => a.frameIdx - b.frameIdx);

      // Compute offsets at each keyframe: Offset = ManualBox - BaseBox
      const offsets = sortedKeyframes.map((k) => {
        const bBox = precomputedBoxes[clamp(k.frameIdx, 0, totalFrames - 1)] || baseBox;
        return {
          frameIdx: k.frameIdx,
          dx: k.box.x - bBox.x,
          dy: k.box.y - bBox.y,
          dw: k.box.w - bBox.w,
          dh: k.box.h - bBox.h
        };
      });

      // Interpolate offsets
      let dx = 0, dy = 0, dw = 0, dh = 0;
      const decayWindow = Math.round(backendFps * 1.5); // Smoothly decay offset to zero over 1.5 seconds

      // Find bounding keyframes relative to the current frame index
      let leftIdx = -1;
      for (let i = 0; i < offsets.length; i++) {
        if (offsets[i].frameIdx <= frameIdx) {
          leftIdx = i;
        } else {
          break;
        }
      }

      if (leftIdx === -1) {
        // Frame lies before the first manual keyframe: decay offset to 0
        const firstK = offsets[0];
        if (frameIdx >= firstK.frameIdx - decayWindow) {
          const t = (frameIdx - (firstK.frameIdx - decayWindow)) / decayWindow;
          dx = firstK.dx * t;
          dy = firstK.dy * t;
          dw = firstK.dw * t;
          dh = firstK.dh * t;
        }
      } else if (leftIdx === offsets.length - 1) {
        // Frame lies after the last manual keyframe: decay offset to 0
        const lastK = offsets[leftIdx];
        if (frameIdx <= lastK.frameIdx + decayWindow) {
          const t = (frameIdx - lastK.frameIdx) / decayWindow;
          dx = lastK.dx * (1 - t);
          dy = lastK.dy * (1 - t);
          dw = lastK.dw * (1 - t);
          dh = lastK.dh * (1 - t);
        }
      } else {
        // Frame lies between two manual keyframes: linearly interpolate offsets
        const k1 = offsets[leftIdx];
        const k2 = offsets[leftIdx + 1];
        const t = (frameIdx - k1.frameIdx) / (k2.frameIdx - k1.frameIdx);
        dx = k1.dx * (1 - t) + k2.dx * t;
        dy = k1.dy * (1 - t) + k2.dy * t;
        dw = k1.dw * (1 - t) + k2.dw * t;
        dh = k1.dh * (1 - t) + k2.dh * t;
      }

      // Return the warped bounding box
      return {
        x: clamp(baseBox.x + dx, 0, videoSize.w),
        y: clamp(baseBox.y + dy, 0, videoSize.h),
        w: clamp(baseBox.w + dw, 24, videoSize.w - (baseBox.x + dx)),
        h: clamp(baseBox.h + dh, 48, videoSize.h - (baseBox.y + dy))
      };
    },
    [precomputedBoxes, keyframes, backendFps, manualBox, videoSize]
  );

  const getScaleAt = useCallback((time: number) => scaleAt(time, backendFps, keyframes, subjectScale), [backendFps, keyframes, subjectScale]);
  const localScale = getScaleAt(currentTime);
  const localScaleMode = scaleScope === "keyframe" && precomputedBoxes.length > 0;

  const drawFrame = useCallback(
    (boxOverride?: Box | null, force = false) => {
      const video = videoRef.current;
      const output = outputCanvasRef.current;
      if (!video || !output || !videoSize.w || !videoSize.h || video.seeking || video.readyState < 2) return;
      const now = performance.now();
      if (!force && now - lastDrawAtRef.current < 33) return; // Cap canvas draw rate to ~30fps for preview smoothness
      lastDrawAtRef.current = now;

      const outputCtx = output.getContext("2d");
      if (!outputCtx) return;

      const targetBox = boxOverride ?? getBoxForFrame(frameAt(video.currentTime, backendFps)) ?? manualBox;
      const nextCrop = targetBox
        ? cropForBox(targetBox, aspect, videoSize.w, videoSize.h, getScaleAt(video.currentTime))
        : cropForBox({ x: 0, y: 0, w: videoSize.w, h: videoSize.h }, aspect, videoSize.w, videoSize.h, 100);

      setCropBox(nextCrop);

      // Render Program Monitor Canvas
      output.width = Math.round(outputSize.w / 2);
      output.height = Math.round(outputSize.w / 2 / ASPECTS[aspect]);
      outputCtx.fillStyle = "#0c0c0e";
      outputCtx.fillRect(0, 0, output.width, output.height);
      outputCtx.imageSmoothingQuality = "high";
      outputCtx.drawImage(
        video,
        nextCrop.x,
        nextCrop.y,
        nextCrop.w,
        nextCrop.h,
        0,
        0,
        output.width,
        output.height
      );
    },
    [aspect, manualBox, outputSize.w, getScaleAt, getBoxForFrame, backendFps, videoSize]
  );

  const tick = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const currTime = video.currentTime;
    setCurrentTime(currTime);

    let activeBox: Box | null = null;
    if (precomputedBoxes.length > 0) {
      const frameIdx = frameAt(currTime, backendFps);
      activeBox = getBoxForFrame(frameIdx);
    } else {
      activeBox = manualBox;
    }

    setTrackedBox(activeBox);
    drawFrame(activeBox);

    if (
      !replacementMutedRef.current &&
      replacementAudioUrl &&
      replacementAudioRef.current?.paused &&
      currTime >= Math.max(0, audioOffset)
    ) {
      void syncReplacementPreview();
    }

    if (!video.paused && !video.ended) {
      animationRef.current = requestAnimationFrame(tick);
    }
  }, [precomputedBoxes, backendFps, getBoxForFrame, drawFrame, manualBox, replacementAudioUrl, audioOffset, sourcePlaybackRate]);

  // Reactive redraw whenever keyframes, current time, aspect, or scale changes
  useEffect(() => {
    if (isDraggingRef.current) return;
    
    let box = manualBox;
    if (precomputedBoxes && precomputedBoxes.length > 0) {
      const frameIdx = frameAt(currentTime, backendFps);
      box = getBoxForFrame(frameIdx);
      setTrackedBox(box);
    }
    
    drawFrame(box, true);
  }, [currentTime, backendFps, getBoxForFrame, drawFrame, precomputedBoxes, manualBox]);

  const refreshDecodedFrame = () => {
    const video = videoRef.current;
    if (!video || video.seeking) return;
    const box = getBoxForFrame(frameAt(video.currentTime, backendFps));
    setCurrentTime(video.currentTime);
    setTrackedBox(box);
    drawFrame(box, true);
  };

  // Restart the playback callback when editing changes its captured trajectory.
  useEffect(() => {
    if (isPlaying) animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, tick]);

  const resetProjectState = () => {
    setIsPlaying(false);
    videoRef.current?.pause();
    replacementAudioRef.current?.pause();
    setManualBox(null);
    setTrackedBox(null);
    setCropBox(null);
    setKeyframes([]);
    setRawBoxes([]);
    setTrackingBreaks([]);
    setNativeOutputPath("");
    modeRef.current = "select";
    setMode("select");
  };

  const selectNativeVideo = async () => {
    if (!window.danceframe) return;
    const file = await window.danceframe.selectVideo();
    if (!file) return;
    if (videoUrl.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    setVideoUrl(file.url);
    setVideoPath(file.path);
    setFileName(file.name);
    resetProjectState();
    sourcePlaybackRateRef.current = 1;
    setSourcePlaybackRate(1);
    setStatus("视频已成功载入！请在左侧框选目标并点击“智能追踪”。");
  };

  const selectNativeAudio = async () => {
    if (!window.danceframe) return;
    const file = await window.danceframe.selectAudio();
    if (!file) return;
    setIsPlaying(false);
    videoRef.current?.pause();
    replacementAudioRef.current?.pause();
    if (replacementAudioUrl.startsWith("blob:")) URL.revokeObjectURL(replacementAudioUrl);
    setReplacementAudioUrl(file.url);
    setReplacementAudioPath(file.path);
    setReplacementAudioName(file.name);
    setBeatMatch(null);
    setReplacementMonitorMuted(false);
    setInspectorTab("audio");
    setStatus("替换音乐已载入。点击“分析对拍”生成首拍偏移和速度建议。");
  };

  const syncReplacementPreview = async () => {
    const video = videoRef.current;
    const audio = replacementAudioRef.current;
    if (!video || !audio || !replacementAudioUrl) return;

    if (video.paused) {
      audio.pause();
      return;
    }

    if (replacementMutedRef.current) {
      audio.pause();
      audio.muted = true;
      return;
    }

    if (audioOffset > 0 && video.currentTime < audioOffset) {
      audio.pause();
      audio.currentTime = 0;
      return;
    }

    const replacementTime = Math.max(0, video.currentTime / sourcePlaybackRateRef.current - audioOffset);
    audio.currentTime = replacementTime;
    audio.playbackRate = 1;
    audio.muted = false;
    audio.volume = replacementVolume;
    await audio.play();
  };

  const applyAudioMonitor = useCallback(async () => {
    const video = videoRef.current;
    const audio = replacementAudioRef.current;
    if (!video) return;

    sourceMutedRef.current = sourceMuted;
    replacementMutedRef.current = replacementMuted;
    sourcePlaybackRateRef.current = sourcePlaybackRate;
    video.muted = sourceMuted;
    video.volume = sourceVolume;
    video.playbackRate = sourcePlaybackRateRef.current;
    if (audio) audio.volume = replacementVolume;
    if (replacementAudioUrl && !replacementMuted) {
      await syncReplacementPreview();
    } else {
      audio?.pause();
    }
  }, [sourceMuted, replacementMuted, sourceVolume, replacementVolume, replacementAudioUrl, audioOffset, sourcePlaybackRate]);

  useEffect(() => {
    if (isPlaying) {
      void applyAudioMonitor();
    }
  }, [applyAudioMonitor, isPlaying]);

  // Synchronize audio and video pause state
  useEffect(() => {
    const video = videoRef.current;
    const audio = replacementAudioRef.current;
    if (!video) return;

    if (!isPlaying) {
      video.pause();
      if (audio) {
        audio.pause();
      }
    }
  }, [isPlaying]);

  // Reset playback state on URL change
  useEffect(() => {
    setIsPlaying(false);
    videoRef.current?.pause();
    replacementAudioRef.current?.pause();
  }, [videoUrl, replacementAudioUrl]);

  const togglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await applyAudioMonitor();
      await video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      replacementAudioRef.current?.pause();
      setIsPlaying(false);
    }
  }, [applyAudioMonitor, tick]);

  // Keyboard shortcut: Spacebar to play/pause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        const active = document.activeElement;
        if (active) {
          const tagName = active.tagName.toLowerCase();
          const type = active.getAttribute("type")?.toLowerCase();
          if (
            tagName === "textarea" ||
            (tagName === "input" && type !== "range" && type !== "checkbox" && type !== "radio") ||
            active.hasAttribute("contenteditable")
          ) {
            return; // Ignore if user is editing text
          }
        }
        e.preventDefault();
        void togglePlay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [togglePlay]);

  const seek = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
    if (replacementAudioRef.current && replacementAudioUrl) {
      replacementAudioRef.current.currentTime = Math.max(0, value / sourcePlaybackRate - audioOffset);
      if (audioOffset > 0 && value / sourcePlaybackRate < audioOffset) {
        replacementAudioRef.current.pause();
      }
    }

    let activeBox: Box | null = null;
    if (precomputedBoxes.length > 0) {
      const frameIdx = frameAt(value, backendFps);
      activeBox = getBoxForFrame(frameIdx);
    } else {
      activeBox = manualBox;
    }

    setTrackedBox(activeBox);
    if (!video.seeking) drawFrame(activeBox, true);
  };

  const analyzeBeatMatch = async () => {
    if (!window.danceframe) {
      setStatus("节拍分析只支持桌面客户端。请用 npm run dev:desktop 打开 Dance Videocut。");
      return;
    }
    if (!videoPath || !replacementAudioPath) {
      if (!videoPath && !replacementAudioPath) {
        setStatus("还不能分析：请先导入源视频，并选择已经保存到本机的替换音乐文件。");
      } else if (!videoPath) {
        setStatus("还不能分析：缺少源视频。对拍需要先读取你原视频里的拍点。");
      } else {
        setStatus("还不能分析：请先选择本机上的替换音乐文件。");
      }
      return;
    }

    setIsAnalyzingBeat(true);
    setStatus("正在用本地 FFmpeg 分析源视频音轨和替换音乐...");
    try {
      const result = await window.danceframe.analyzeBeat({
        inputPath: videoPath,
        replacementAudioPath
      });
      if (!result.ok) {
        setStatus(`节拍分析失败: ${result.error}`);
        return;
      }
      const { source, replacement, offset, rate, alignmentScore } = result;
      const confident = (alignmentScore ?? 0) >= 0.35;
      setBeatMatch({ source, replacement, offset, rate });
      if (confident) {
        setAudioOffset(Number(offset.toFixed(2)));
      }
      setReplacementMonitorMuted(false);
      if (confident) {
        setStatus(`对拍完成：源 ${Math.round(source.bpm)} BPM，替换音乐 ${Math.round(replacement.bpm)} BPM。音乐速度保持 1.000x，请用监听切换微调偏移。`);
      } else {
        setStatus(`已读出 BPM，但整段匹配置信度偏低，未自动改偏移。请切换监听后手动微调首拍偏移。`);
      }
    } catch (err: any) {
      setStatus(`节拍分析失败: ${err.message}`);
    } finally {
      setIsAnalyzingBeat(false);
    }
  };

  // Triggers offline YOLO tracking on the backend
  const startTracking = async (relockBox?: Box, relockTime?: number) => {
    if (editingLocked) return;
    const seedBox = relockBox ?? trackedBox ?? manualBox;
    const seedTime = relockTime ?? videoRef.current?.currentTime ?? currentTime;
    const relocking = Boolean(relockBox && hasTracking);
    if (!window.danceframe) {
      setStatus("当前未处于桌面客户端环境，无法启动 AI 追踪。");
      return;
    }
    if (!videoPath || !seedBox) {
      setStatus("请先在画面中框出目标，再启动智能追踪。");
      return;
    }

    videoRef.current?.pause();
    setIsTrackingBackend(true);
    setTrackProgress(0);
    setStatus(relocking ? "正在从当前帧重新锁定人物，之前的轨迹会保留..." : "AI 追踪引擎启动中...");

    try {
      const result = await window.danceframe.trackVideo({
        rawTrajectory: true,
        inputPath: videoPath,
        aspect,
        videoSize,
        duration,
        subjectScale,
        smoothing,
        currentTime: seedTime,
        box: seedBox
      });

      setIsTrackingBackend(false);
      if (result.ok) {
        if (relocking) {
          if (Math.abs(result.fps - backendFps) > .001) throw new Error("视频帧率已变化，请重新分析整段视频。");
          const boundary = clamp(frameAt(seedTime, result.fps), 0, result.boxes.length - 1);
          const merged = mergeRelock(rawBoxes, result.boxes, boundary);
          setRawBoxes(merged);
          setTrackingBreaks(prev => [...prev.filter(f => f < boundary), boundary]);
          setKeyframes(prev => retirePositionKeys(prev, boundary, result.fps));
        } else {
          setRawBoxes(result.boxes);
          setTrackingBreaks([]);
          // Scale edits survive analysis; positional offsets belonged to the old path.
          setKeyframes(prev => prev.map(k => ({ ...k, position: false })));
        }
        setManualBox(seedBox);
        setBackendFps(result.fps);
        setMode("track");
        modeRef.current = "track";
        const uncertain = (result.uncertainFrames ?? []).filter(f => !relocking || f >= frameAt(seedTime, result.fps)).length;
        setStatus(`${relocking ? "已从当前帧重新锁定人物，后续轨迹已更新。" : "人物追踪完成。"}${uncertain ? `有 ${uncertain} 帧匹配不确定，已保持最近可靠位置；可拖框调整后点击“从当前帧重新锁定后续人物”。` : "可以播放预览；拖动人物框可保存当前帧位移。"}`);
      } else {
        setStatus(result.error === "已取消分析" ? "已取消分析，可调整目标后重新开始。" : `智能追踪失败: ${result.error}`);
      }
    } catch (err: any) {
      setIsTrackingBackend(false);
      setStatus(`AI 后端连接出错: ${err.message}`);
    }
  };

  const addManualKeyframe = () => {
    if (!hasTracking || editingLocked) return;
    videoRef.current?.pause();
    const box = trackedBox ?? manualBox;
    if (!box) return;

    const keyTime = videoRef.current?.currentTime ?? 0;
    // Check if keyframe already exists at this frame
    const frameIdx = frameAt(keyTime, backendFps);
    setKeyframes((prev) => {
      const existing = prev.find(k => frameAt(k.time, backendFps) === frameIdx);
      const filtered = prev.filter((k) => frameAt(k.time, backendFps) !== frameIdx);
      return [...filtered, { ...existing, time: keyTime, box, subjectScale: existing?.subjectScale ?? getScaleAt(keyTime), source: "manual" as const, position: true, positionEnd: undefined }].sort((a, b) => a.time - b.time);
    });
    setStatus(`已在时间点 ${formatTime(keyTime)} 添加手动修偏关键帧。`);
  };

  const relockFromCurrentFrame = () => {
    const video = videoRef.current;
    if (!video || video.seeking || !hasTracking || editingLocked) return;
    const time = video.currentTime;
    const box = getBoxForFrame(frameAt(time, backendFps));
    if (box) void startTracking(box, time);
  };

  const deleteKeyframe = (e: React.MouseEvent, indexToDelete: number) => {
    e.stopPropagation(); // Prevent trigger seek
    setKeyframes((prev) => prev.filter((_, idx) => idx !== indexToDelete));
    setStatus("已删除指定的修偏关键帧。");
  };

  const resetWork = () => {
    resetProjectState();
    setStatus("工作台已重置，请重新导入视频或重新拉框。");
  };

  const exportVideo = async () => {
    if (!videoUrl || !videoSize.w) {
      setStatus("请先导入视频，再进行导出。");
      return;
    }

    const activeBox = manualBox || (precomputedBoxes.length > 0 ? precomputedBoxes[0] : null) || {
      x: 0,
      y: 0,
      w: videoSize.w,
      h: videoSize.h
    };

    if (window.danceframe && videoPath) {
      setExporting(true);
      setExportProgress(0);
      setNativeOutputPath("");
      setStatus("正在导出 MP4...");

      // Compute final array of boxes for every frame to achieve 100% WYSIWYG
      const finalBoxes = precomputedBoxes.length > 0
        ? precomputedBoxes.map((_, idx) => {
            const b = getBoxForFrame(idx);
            return boxAtScale(b || activeBox, subjectScale, getScaleAt(idx / backendFps));
          })
        : undefined;

      const result = await window.danceframe.exportVideo({
        inputPath: videoPath,
        aspect,
        videoSize,
        duration,
        subjectScale,
        smoothing,
        currentTime,
        box: activeBox,
        boxes: finalBoxes,
        replacementAudioPath: replacementAudioPath || undefined,
        replacementAudioOffset: replacementAudioPath ? audioOffset : undefined,
        sourcePlaybackRate,
        static: precomputedBoxes.length === 0
      });

      setExporting(false);
      if ("canceled" in result) {
        setStatus("导出已取消。");
        return;
      }
      if (result.ok) {
        setNativeOutputPath(result.outputPath);
        setExportProgress(100);
        setStatus(`导出成功！视频已保存。`);
      } else {
        setStatus(`导出失败: ${result.error}`);
      }
    }
  };

  const handleBoxPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (editingLocked || videoRef.current?.seeking) return;
    videoRef.current?.pause(); // Pause before editing this frame
    if (!videoRef.current || !videoFrameRef.current || !videoSize.w || !videoSize.h) return;

    const rect = videoFrameRef.current.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;

    const currentFrameBox = trackedBox ?? manualBox;
    if (!currentFrameBox) return;

    const initX = currentFrameBox.x;
    const initY = currentFrameBox.y;
    const boxW = currentFrameBox.w;
    const boxH = currentFrameBox.h;

    const pointerId = event.pointerId;
    const target = event.currentTarget;
    target.setPointerCapture(pointerId);
    isDraggingRef.current = true;

    const update = (moveEvent: PointerEvent) => {
      const dx_pixels = moveEvent.clientX - startX;
      const dy_pixels = moveEvent.clientY - startY;

      const dx_video = (dx_pixels / rect.width) * videoSize.w;
      const dy_video = (dy_pixels / rect.height) * videoSize.h;

      const newX = clamp(initX + dx_video, 0, videoSize.w - boxW);
      const newY = clamp(initY + dy_video, 0, videoSize.h - boxH);

      const updatedBox = {
        x: newX,
        y: newY,
        w: boxW,
        h: boxH
      };

      if (!hasTracking) setManualBox(updatedBox);
      setTrackedBox(updatedBox);
      drawFrame(updatedBox, true);
    };

    const stop = (upEvent: PointerEvent) => {
      try {
        target.releasePointerCapture(pointerId);
      } catch {}
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", stop);
      isDraggingRef.current = false;

      const dx_pixels = upEvent.clientX - startX;
      const dy_pixels = upEvent.clientY - startY;
      const dx_video = (dx_pixels / rect.width) * videoSize.w;
      const dy_video = (dy_pixels / rect.height) * videoSize.h;

      const finalBox = {
        x: clamp(initX + dx_video, 0, videoSize.w - boxW),
        y: clamp(initY + dy_video, 0, videoSize.h - boxH),
        w: boxW,
        h: boxH
      };

      if (hasTracking) {
        const keyTime = videoRef.current?.currentTime ?? 0;
        if (Math.hypot(dx_pixels, dy_pixels) >= 3) {
          const frameIdx = frameAt(keyTime, backendFps);
          setKeyframes(prev => {
            const existing = prev.find(k => frameAt(k.time, backendFps) === frameIdx);
            const updated: Keyframe = {
              ...existing,
              time: keyTime,
              box: finalBox,
              subjectScale: existing?.subjectScale ?? getScaleAt(keyTime),
              source: "manual",
              position: true,
              positionEnd: undefined
            };
            return [...prev.filter(k => frameAt(k.time, backendFps) !== frameIdx), updated].sort((a, b) => a.time - b.time);
          });
          setStatus(`已保存 ${formatTime(keyTime)} 的位移关键帧。`);
        }
      } else {
        setStatus("初始框选目标已调整，请点击右侧的“智能分析追踪 (YOLO)”启动分析。");
      }
    };

    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", stop);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editingLocked || hasTracking) return;
    videoRef.current?.pause();
    if (!overlayRef.current || !videoFrameRef.current || !videoSize.w || !videoSize.h) return;
    const rect = videoFrameRef.current.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;
    const pointerId = event.pointerId;
    overlayRef.current.setPointerCapture(pointerId);
    isDraggingRef.current = true;

    const update = (moveEvent: PointerEvent) => {
      const endX = clamp(moveEvent.clientX - rect.left, 0, rect.width);
      const endY = clamp(moveEvent.clientY - rect.top, 0, rect.height);
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const w = Math.abs(endX - startX);
      const h = Math.abs(endY - startY);

      const box = {
        x: (x / rect.width) * videoSize.w,
        y: (y / rect.height) * videoSize.h,
        w: (w / rect.width) * videoSize.w,
        h: (h / rect.height) * videoSize.h
      };

      setManualBox(box);
      setTrackedBox(box);
      drawFrame(box);
    };

    const stop = () => {
      overlayRef.current?.releasePointerCapture(pointerId);
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", stop);
      isDraggingRef.current = false;
      
      setStatus("裁剪目标已选择。如果是首次追踪，请点击右侧面板的“智能分析追踪 (YOLO)”。");
    };

    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", stop);
  };

  // Convert keyframe time markers to percentages for visual timeline indicators
  const keyframeMarkers = useMemo(() => {
    if (!duration) return [];
    return keyframes.map((k, idx) => ({
      index: idx,
      pct: (k.time / duration) * 100,
      time: k.time
    }));
  }, [keyframes, duration]);

  const displayedBox = trackedBox ?? manualBox;
  const boxStyle = displayedBox
    ? {
        left: `${(displayedBox.x / videoSize.w) * 100}%`,
        top: `${(displayedBox.y / videoSize.h) * 100}%`,
        width: `${(displayedBox.w / videoSize.w) * 100}%`,
        height: `${(displayedBox.h / videoSize.h) * 100}%`
      }
    : undefined;

  const cropStyle = cropBox
    ? {
        left: `${(cropBox.x / videoSize.w) * 100}%`,
        top: `${(cropBox.y / videoSize.h) * 100}%`,
        width: `${(cropBox.w / videoSize.w) * 100}%`,
        height: `${(cropBox.h / videoSize.h) * 100}%`
      }
    : undefined;

  const beatActionLabel = isAnalyzingBeat
    ? "正在分析对拍"
    : !videoPath
      ? "先导入源视频"
      : !replacementAudioPath
        ? "先选择替换音乐"
        : "分析对拍";
  const beatHint = replacementAudioPath
    ? "已准备替换音乐；可分析节拍后在轨道里切换静音并微调偏移。"
    : "选择本地替换音乐后，系统会用源视频音轨和新音频做本地对齐。";
  const outputCurrentTime = currentTime / sourcePlaybackRate;
  const visibleTimelineDuration = Math.max((duration || 0) / sourcePlaybackRate, 4);
  const sourceBeatMarkers = useMemo(
    () => (beatMatch?.source.beats ?? [])
      .map((time) => time / sourcePlaybackRate)
      .filter((time) => time >= 0 && time <= visibleTimelineDuration)
      .slice(0, 80),
    [beatMatch, sourcePlaybackRate, visibleTimelineDuration]
  );
  const replacementBeatMarkers = useMemo(
    () => (beatMatch?.replacement.beats ?? [])
      .map((time) => time + audioOffset)
      .filter((time) => time >= 0 && time <= visibleTimelineDuration)
      .slice(0, 80),
    [beatMatch, audioOffset, visibleTimelineDuration]
  );
  const replacementStartLabel = audioOffset < 0
    ? `从新音频 ${Math.abs(audioOffset).toFixed(3)}s 开始`
    : `新音频延后 ${audioOffset.toFixed(3)}s`;

  return (
    <main className="app professional-studio">
      {/* Studio Header Bar */}
      <header className="studio-header">
        <div className="brand">
          <div className="brandMark">
            <Scissors size={18} />
          </div>
          <div>
            <h1>Dance Videocut</h1>
            <p>Mac 本地舞蹈跟踪视频重构工作台</p>
          </div>
        </div>

        <div className="topActions">
          <button className="importButton" onClick={selectNativeVideo} disabled={!isDesktop || editingLocked}>
            <HardDrive size={15} />
            <span>导入视频</span>
          </button>
        </div>
      </header>

      {/* Main Studio Editor Workspace */}
      <section className="studio-workspace">
        <div className="editor-stage-pane">
          {/* Dual Monitor Layout */}
          <div className="monitors-row">
            {/* Monitor 1: Source Video (Original) */}
            <div className="monitor source-monitor">
              <div className="monitor-header">
                <Tv size={14} />
                <span>源视频监视器 (Source Monitor)</span>
                {videoSize.w ? (
                  <span className="metadata-badge">
                    {videoSize.w} x {videoSize.h} | {backendFps.toFixed(2)} FPS
                  </span>
                ) : null}
              </div>
              <div className="sourceStage">
                {!videoUrl ? (
                  <div className="emptyState">
                    <Film size={44} />
                    <h2>未载入视频工程</h2>
                    <p>点击“导入视频”选择本地多人或集体舞视频，框选人物以开启 AI 裁剪运镜工作流。</p>
                  </div>
                ) : (
                  <div ref={videoFrameRef} className="videoFrame">
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      playsInline
                      muted={sourceMuted}
                      onLoadedMetadata={(e) => {
                        const video = e.currentTarget;
                        setVideoSize({ w: video.videoWidth, h: video.videoHeight });
                        setDuration(video.duration || 0);

                      }}
                      onSeeked={refreshDecodedFrame}
                      onLoadedData={refreshDecodedFrame}
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                      onEnded={() => setIsPlaying(false)}
                      onPause={() => {
                        setIsPlaying(false);
                        replacementAudioRef.current?.pause();
                      }}
                      onPlay={() => {
                        setIsPlaying(true);
                      }}
                    />
                    <audio ref={replacementAudioRef} src={replacementAudioUrl || undefined} />
                    <div ref={overlayRef} className="selectionOverlay" onPointerDown={handlePointerDown}>
                      {cropStyle && <div className="cropGuide" style={cropStyle} />}
                      {boxStyle && (
                        <div
                          className="subjectBox"
                          style={boxStyle}
                          onPointerDown={handleBoxPointerDown}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Monitor 2: Crop Output (Program) */}
            <div className="monitor program-monitor">
              <div className="monitor-header">
                <Tv size={14} />
                <span>裁切输出监视器 (Program Monitor)</span>
                <span className="metadata-badge active">
                  {aspect} | {outputSize.w} x {outputSize.h}
                </span>
              </div>
              <div className="previewPane">
                {videoUrl ? (
                  <div className="phoneShell">
                    <canvas ref={outputCanvasRef} />
                  </div>
                ) : (
                  <div className="previewEmpty">
                    <Film size={44} />
                    <p>等待源视频载入</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Bottom Timeline & Transport Panel */}
          <div className="studio-timeline-panel">
            <div className="transport-controls">
              <button
                className="iconButton playPause"
                onClick={togglePlay}
                disabled={!videoUrl}
                title={isPlaying ? "暂停" : "播放"}
              >
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <div className="timecode-display">
                <span className="curr">{formatTime(outputCurrentTime)}</span>
                <span className="divider">/</span>
                <span className="total">{formatTime(duration / sourcePlaybackRate)}</span>
              </div>
            </div>

            <div className="unified-timeline">
              <div className="timeline-ruler">
                {[0, 1, 2, 3, 4].map((tick) => (
                  <span key={tick} style={{ left: `${(tick / 4) * 100}%` }}>
                    {formatTime((visibleTimelineDuration * tick) / 4).slice(0, 5)}
                  </span>
                ))}
              </div>
              <div
                className="unified-playhead"
                style={{
                  left: `calc(138px + ${visibleTimelineDuration ? clamp(outputCurrentTime / visibleTimelineDuration, 0, 1) : 0} * (100% - 138px))`
                }}
              />

              <div className="timeline-tracks">
                <div className="timeline-track video-track">
                  <div className="timeline-track-label">
                    <Film size={14} />
                    <span>视频</span>
                  </div>
                  <div className="timeline-track-lane">
                    <div className="timeline-clip video-clip">
                      <span>{fileName || "未导入视频"}</span>
                    </div>
                    <input
                      className="timeline-scrubber"
                      type="range"
                      min="0"
                      max={visibleTimelineDuration}
                      step="0.01"
                      value={outputCurrentTime}
                      onChange={(e) => seek(Number(e.target.value) * sourcePlaybackRate)}
                      disabled={!videoUrl}
                      aria-label="视频播放位置"
                    />
                    <div className="keyframe-track">
                      {keyframeMarkers.map((m) => (
                        <div
                          key={m.index}
                          className="keyframe-diamond"
                          style={{ left: `${m.pct}%` }}
                          onClick={() => { videoRef.current?.pause(); seek(m.time); }}
                          title={`关键帧 ${formatTime(m.time)}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="timeline-track audio-track">
                  <div className="timeline-track-label audio-label">
                    <button
                      className={`trackMute ${sourceMuted ? "muted" : ""}`}
                      onClick={() => setSourceMonitorMuted(!sourceMutedRef.current)}
                      disabled={!videoUrl}
                      title={sourceMuted ? "打开原声" : "关闭原声"}
                    >
                      {sourceMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                    </button>
                    <span>原声</span>
                    <input
                      className="track-volume"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={sourceVolume}
                      onChange={(e) => setSourceVolume(Number(e.target.value))}
                      disabled={!videoUrl}
                      aria-label="原声音量"
                      title={`原声音量 ${Math.round(sourceVolume * 100)}%`}
                    />
                    <output>{Math.round(sourceVolume * 100)}</output>
                  </div>
                  <div className="timeline-track-lane audio-lane source-lane">
                    <div className="timeline-clip source-clip">
                      {sourceBeatMarkers.map((time, index) => (
                        <i key={`${time}-${index}`} style={{ left: `${(time / visibleTimelineDuration) * 100}%` }} />
                      ))}
                      <span>{fileName || "源视频原声"}</span>
                    </div>
                  </div>
                </div>

                {replacementAudioUrl && (
                  <div className="timeline-track audio-track">
                    <div className="timeline-track-label audio-label">
                      <button
                        className={`trackMute ${replacementMuted ? "muted" : ""}`}
                        onClick={() => setReplacementMonitorMuted(!replacementMutedRef.current)}
                        disabled={!replacementAudioUrl}
                        title={replacementMuted ? "打开替换音乐" : "关闭替换音乐"}
                      >
                        {replacementMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                      </button>
                      <span>新音频</span>
                      <input
                        className="track-volume"
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={replacementVolume}
                        onChange={(e) => setReplacementVolume(Number(e.target.value))}
                        disabled={!replacementAudioUrl}
                        aria-label="新音频音量"
                        title={`新音频音量 ${Math.round(replacementVolume * 100)}%`}
                      />
                      <output>{Math.round(replacementVolume * 100)}</output>
                    </div>
                    <div className="timeline-track-lane audio-lane replacement-lane">
                      <div
                        className="timeline-clip replacement-clip"
                        style={{
                          left: `${clamp((Math.max(0, audioOffset) / visibleTimelineDuration) * 100, 0, 100)}%`,
                          width: `${audioOffset > 0 ? clamp(((visibleTimelineDuration - audioOffset) / visibleTimelineDuration) * 100, 0, 100) : 100}%`
                        }}
                      >
                        {replacementBeatMarkers.map((time, index) => (
                          <i key={`${time}-${index}`} style={{ left: `${(time / visibleTimelineDuration) * 100}%` }} />
                        ))}
                        <span>{replacementAudioUrl ? `${replacementAudioName} · ${replacementStartLabel}` : "选择替换音乐"}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Sidebar Inspector (Controls and Keyframes) */}
        <aside className="studio-inspector">
          <div className="panelTitle">
            <WandSparkles size={16} />
            <h2>参数检查器 (Inspector)</h2>
          </div>

          <div className="inspectorTabs">
            <button
              className={inspectorTab === "video" ? "active" : ""}
              onClick={() => setInspectorTab("video")}
            >
              视频剪辑
            </button>
            <button
              className={inspectorTab === "audio" ? "active" : ""}
              onClick={() => setInspectorTab("audio")}
            >
              音频对齐
            </button>
          </div>

          <div className="inspector-scroll-area">
            {inspectorTab === "video" && (
              <>
            {/* AI Smart Tracking Panel */}
            <div className="inspector-card ai-tracking-card">
              <label className="inspector-label">人物追踪</label>
              <p className="workflow-hint" role="status">{!videoUrl ? "先导入视频，开始构图" : isTrackingBackend ? "正在分析，请稍候。完成后可调整运镜和关键帧。" : hasTracking ? "拖动人物框调整当前帧；需要后续轨迹跟随时，点击下方重新锁定" : !manualBox ? "在左侧框选要跟随的人物" : "目标已选择 · 可先调整占比预览构图，再开始追踪"}</p>
              <button
                className="action-button tracking"
                onClick={() => void startTracking()}
                disabled={!manualBox || editingLocked}
              >
                <UserRoundSearch size={14} />
                <span>{isTrackingBackend ? "正在分析人物轨迹…" : hasTracking ? "重新分析人物追踪" : "开始人物追踪"}</span>
              </button>
              {hasTracking && (
                <button
                  className="action-button relock"
                  onClick={relockFromCurrentFrame}
                  disabled={!trackedBox || editingLocked}
                >
                  <Focus size={14} />
                  <span>从当前帧重新锁定后续人物</span>
                </button>
              )}

              {isTrackingBackend && <button className="action-button cancel-tracking" onClick={() => window.danceframe?.cancelTracking()}>取消分析</button>}
              {isTrackingBackend ? (
                <div className="progressBox inline orange">
                  <div style={{ width: `${trackProgress}%` }} />
                  <span>AI 追踪计算中: {Math.round(trackProgress)}%</span>
                </div>
              ) : precomputedBoxes && precomputedBoxes.length > 0 ? (
                <div className="progressBox inline" style={{ borderColor: "rgba(0, 240, 181, 0.25)" }}>
                  <div style={{ width: "100%", background: "var(--accent-teal)" }} />
                  <span style={{ color: "var(--accent-teal)" }}>AI 轨迹分析已就绪: 100%</span>
                </div>
              ) : null}
            </div>
            {/* Aspect Ratios Selector */}
            <div className="inspector-card">
              <label className="inspector-label">构图比例</label>
              <div className="segmented">
                {(Object.keys(ASPECTS) as Aspect[]).map((item) => (
                  <button
                    key={item}
                    className={aspect === item ? "active" : ""}
                    disabled={!videoUrl || editingLocked}
                    onClick={() => setAspect(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            {/* Scale and Smoothing Sliders */}
            <div className="inspector-card">
              <div className="fieldGroup">
                <label className="inspector-label">人物画面占比</label>
                {precomputedBoxes.length > 0 && (
                  <div className="scale-scope-control">
                    <div className="segmented scale-scope" role="group" aria-label="占比调整范围">
                      <button type="button" disabled={editingLocked} className={scaleScope === "global" ? "active" : ""} aria-pressed={scaleScope === "global"} onClick={() => setScaleScope("global")}>
                        全局
                      </button>
                      <button type="button" disabled={editingLocked} className={scaleScope === "keyframe" ? "active" : ""} aria-pressed={scaleScope === "keyframe"} onClick={() => setScaleScope("keyframe")}>
                        当前关键帧
                      </button>
                    </div>
                    <p className="scale-scope-hint">{localScaleMode ? "调整自动保存到当前帧" : "调整默认占比，保留已单独设置的关键帧"}</p>
                  </div>
                )}
                <div className="sliderRow">
                  <input
                    type="range"
                    min="42"
                    max="86"
                    value={localScaleMode ? localScale : subjectScale}
                    disabled={!manualBox || editingLocked}
                    aria-label="人物画面占比"
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (!localScaleMode) { setSubjectScale(value); return; }
                      const video = videoRef.current;
                      if (!video || video.seeking) return;
                      video.pause();
                      const time = video.currentTime;
                      const index = frameAt(time, backendFps);
                      const box = getBoxForFrame(index);
                      if (!box) return;
                      setKeyframes(prev => {
                        const existing = prev.find(k => frameAt(k.time, backendFps) === index);
                        const updated = { ...existing, time, box, subjectScale: value, source: "manual" as const, position: existing ? existing.position : false };
                        return [...prev.filter(k => frameAt(k.time, backendFps) !== index), updated].sort((a, b) => a.time - b.time);
                      });
                      setStatus(`当前帧修正已保存 · ${formatTime(time)}`);
                    }}
                  />
                  <strong>{Math.round(localScaleMode ? localScale : subjectScale)}%</strong>
                </div>
                {!hasTracking && <p className="scale-scope-hint">{manualBox ? "当前为静态构图预览，追踪后自动跟随人物" : "框选人物后可调整"}</p>}
              </div>

              <div className="fieldGroup" style={{ marginTop: "12px" }}>
                <label className="inspector-label">运镜平滑度</label>
                <div className="sliderRow">
                  <input
                    type="range"
                    min="0"
                    max="92"
                    value={smoothing}
                    aria-label="运镜平滑度"
                    disabled={!hasTracking || editingLocked}
                    onChange={(e) => setSmoothing(Number(e.target.value))}
                  />
                  <strong>{smoothing}%</strong>
                </div>
                <div className="slider-endpoints"><span>灵敏跟随</span><span>平稳运镜</span></div>
                <p className="scale-scope-hint">{hasTracking ? "调整即时预览，无需重新追踪" : "完成人物追踪后可调整"}</p>
              </div>
            </div>

              </>
            )}

            {inspectorTab === "audio" && (
              <div className="inspector-card beatmatch-card audio-workbench">
                <label className="inspector-label">音频对齐</label>
                <p className="beatHint">{beatHint}</p>

              <div className="audioImportRow">
                <button className="action-button audio" onClick={selectNativeAudio} disabled={!isDesktop || editingLocked}>
                  <Music2 size={14} />
                  <span>选择替换音乐</span>
                </button>
              </div>

              <div className="audioName">
                <AudioWaveform size={13} />
                <span>{replacementAudioName || "未选择替换音乐文件"}</span>
              </div>

              <button
                className="action-button beat"
                onClick={analyzeBeatMatch}
                disabled={isAnalyzingBeat}
              >
                <AudioWaveform size={14} />
                <span>{beatActionLabel}</span>
              </button>

              {beatMatch && (
                <div className="beatStats">
                  <div>
                    <span>源视频</span>
                    <strong>{Math.round(beatMatch.source.bpm)} BPM</strong>
                    <em>首拍 {beatMatch.source.firstBeat.toFixed(2)}s</em>
                  </div>
                  <div>
                    <span>替换音乐</span>
                    <strong>{Math.round(beatMatch.replacement.bpm)} BPM</strong>
                    <em>首拍 {beatMatch.replacement.firstBeat.toFixed(2)}s</em>
                  </div>
                  <div>
                    <span>原素材速度</span>
                    <strong>{sourcePlaybackRate.toFixed(2)}x</strong>
                    <em>目标音乐 1.00x</em>
                  </div>
                </div>
              )}

              <div className="fieldGroup">
                <label className="inspector-label">首拍偏移 (秒)</label>
                <div className="sliderRow numberRow">
                  <input
                    type="range"
                    min="-180"
                    max="8"
                    step="0.01"
                    value={audioOffset}
                    onChange={(e) => setAudioOffset(Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min="-180"
                    max="8"
                    step="0.001"
                    value={audioOffset}
                    onChange={(e) => setAudioOffset(Number(e.target.value))}
                  />
                </div>
                <div className="nudgeRow">
                  {[-0.05, -0.02, -0.01, 0.01, 0.02, 0.05].map((delta) => (
                    <button
                      key={delta}
                      onClick={() => setAudioOffset((value) => Number((value + delta).toFixed(3)))}
                    >
                      {delta > 0 ? "+" : ""}{delta.toFixed(2)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fieldGroup">
                <label className="inspector-label">原素材速度</label>
                <div className="sourceSpeedPresets" role="group" aria-label="原视频和原声速度">
                  {SOURCE_SPEED_PRESETS.map((rate) => (
                    <button
                      key={rate}
                      className={sourcePlaybackRate === rate ? "active" : ""}
                      onClick={() => {
                        sourcePlaybackRateRef.current = rate;
                        setSourcePlaybackRate(rate);
                      }}
                      title={`原视频和原声 ${rate.toFixed(2)}x`}
                    >
                      {rate === 1 ? "1.00x" : `${rate}x`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            )}

            {inspectorTab === "video" && (
              <>

            {/* Manual Keyframe Adjuster */}
            <div className="inspector-card">
              <label className="inspector-label">关键帧修正</label>
              <button
                className="action-button keyframe-btn"
                onClick={addManualKeyframe}
                disabled={!hasTracking || editingLocked || !displayedBox}
              >
                <Focus size={14} />
                <span>在当前帧添加修正关键帧</span>
              </button>
            </div>

            {/* Manual Keyframes List */}
            <div className="inspector-card keyframe-list-card">
              <label className="inspector-label">修正关键帧列表 ({keyframes.length})</label>
              {keyframes.length === 0 ? (
                <p className="no-keyframes-tip">{hasTracking ? "拖动人物框保存当前帧位移；占比调整保存当前帧大小。" : "完成人物追踪后，可逐帧修正位置和大小。"}</p>
              ) : (
                <div className="keyframes-scroll">
                  {keyframes.map((frame, index) => (
                    <div
                      key={`${frame.time}-${index}`}
                      className="keyframe-item"
                      onClick={() => { videoRef.current?.pause(); seek(frame.time); }}
                    >
                      <span className="k-time">{formatTime(frame.time)}</span>
                      <div className="k-actions">
                        <span className="k-badge">手动修偏 · {Math.round(frame.subjectScale ?? subjectScale)}%</span>
                        <button
                          className="k-delete"
                          disabled={editingLocked}
                          onClick={(e) => deleteKeyframe(e, index)}
                          title="删除该关键帧"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

              </>
            )}

            {/* Render & Export Center */}
            <div className="inspector-card export-card">
              <label className="inspector-label">渲染压制导出</label>
              <button
                className="action-button primary export"
                onClick={exportVideo}
                disabled={!manualBox || editingLocked}
              >
                <Clapperboard size={14} />
                <span>{exporting ? "正在渲染导出" : "导出 MP4 视频"}</span>
              </button>

              {exporting && (
                <div className="progressBox inline orange">
                  <div style={{ width: `${exportProgress}%` }} />
                  <span>正在导出 {exportProgress}%</span>
                </div>
              )}

              {nativeOutputPath && (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }} className="mt-10">
                  <div className="outputPath" style={{ width: "100%" }}>
                    <BadgeCheck size={14} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {nativeOutputPath}
                    </span>
                  </div>
                  <button
                    className="action-button"
                    style={{
                      height: "30px",
                      fontSize: "11px",
                      borderColor: "rgba(0, 240, 181, 0.25)",
                      color: "var(--accent-teal)",
                      backgroundColor: "rgba(0, 240, 181, 0.03)"
                    }}
                    onClick={async () => {
                      if (window.danceframe && window.danceframe.showItemInFolder) {
                        try {
                          await window.danceframe.showItemInFolder(nativeOutputPath);
                        } catch (err: any) {
                          setStatus(`定位文件失败: ${err.message}`);
                        }
                      } else {
                        setStatus("无法定位文件，请确保您已关闭并彻底重启了桌面客户端程序。");
                      }
                    }}
                  >
                    <FolderOpen size={13} />
                    <span>定位至导出文件</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Reset / General Status */}
          <div className="inspector-card footer-card">
            <button className="action-button reset" onClick={resetWork} disabled={!videoUrl || editingLocked}>
              <RotateCcw size={13} />
              <span>重置项目工程</span>
            </button>
            <div className="status-indicator">
              <div className="status-dot" />
              <span className="status-text">{status}</span>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
