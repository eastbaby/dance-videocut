/// <reference types="vite/client" />

type NativeVideoFile = {
  path: string;
  name: string;
  url: string;
};

type NativeAudioFile = NativeVideoFile;

type EngineDiagnostics = {
  python: string;
  ffmpeg: string;
  accelerator: string;
};

type BeatAnalysis = {
  bpm: number;
  firstBeat: number;
  beats: number[];
  confidence: number;
  duration?: number;
};

type EngineBeatJob = {
  inputPath: string;
  replacementAudioPath: string;
};

type EngineExportJob = {
  inputPath: string;
  aspect: string;
  videoSize: { w: number; h: number };
  duration: number;
  subjectScale: number;
  box: { x: number; y: number; w: number; h: number };
  smoothing?: number;
  currentTime?: number;
  boxes?: { x: number; y: number; w: number; h: number }[];
  replacementAudioPath?: string;
  replacementAudioOffset?: number;
  sourcePlaybackRate?: number;
  static?: boolean;
};

type EngineTrackJob = {
  rawTrajectory?: boolean;
  inputPath: string;
  aspect: string;
  videoSize: { w: number; h: number };
  duration: number;
  subjectScale: number;
  smoothing: number;
  currentTime: number;
  box: { x: number; y: number; w: number; h: number };
};

type EngineTrackResult =
  | { ok: true; boxes: { x: number; y: number; w: number; h: number }[]; fps: number; uncertainFrames?: number[] }
  | { ok: false; error: string };

type EngineBeatResult =
  | { ok: true; source: BeatAnalysis; replacement: BeatAnalysis; offset: number; rate: number; alignmentScore?: number }
  | { ok: false; error: string };

type EngineExportResult =
  | { canceled: true }
  | { ok: true; outputPath: string }
  | { ok: false; error: string };

type EngineProgressMessage =
  | { type: "phase"; message: string; crop?: { x: number; y: number; w: number; h: number } }
  | { type: "progress"; progress: number }
  | { type: "done"; outputPath: string }
  | { type: "error"; message: string }
  | { type: "log"; message: string };

interface Window {
  danceframe?: {
    selectVideo: () => Promise<NativeVideoFile | null>;
    selectAudio: () => Promise<NativeAudioFile | null>;
    diagnostics: () => Promise<EngineDiagnostics>;
    analyzeBeat: (job: EngineBeatJob) => Promise<EngineBeatResult>;
    cancelTracking: () => Promise<boolean>;
    trackVideo: (job: EngineTrackJob) => Promise<EngineTrackResult>;
    exportVideo: (job: EngineExportJob) => Promise<EngineExportResult>;
    showItemInFolder: (path: string) => Promise<boolean>;
    onEngineProgress: (callback: (message: EngineProgressMessage) => void) => () => void;
  };
}
