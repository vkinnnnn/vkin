// Type declarations for the renderer scripts (checked by tsconfig.renderer.json). The preload bridge
// (src/preload.js) is the only API the sandboxed renderers can reach.
export {};

interface CopilotCapture {
  sendFrame(channel: string, buffer: ArrayBuffer, level: number): void;
  sendStatus(status: { channel: string; state: string; sampleRate?: number; error?: string }): void;
  onCmd(cb: (msg: { cmd: string; channels?: string[] }) => void): void;
}

interface CopilotUi {
  onEvent(cb: (msg: any) => void): void;
  send(cmd: string, args?: Record<string, any>): void;
  invoke(cmd: string, args?: Record<string, any>): Promise<any>;
}

interface CopilotPrep {
  invoke(cmd: string, args?: Record<string, any>): Promise<any>;
}

declare global {
  interface Window {
    copilot: { capture: CopilotCapture; ui: CopilotUi; prep: CopilotPrep };
  }
  // Shared helpers loaded with <script> tags before the page scripts.
  var PCM: {
    Downsampler: new (inRate: number, outRate?: number) => { process(x: Float32Array): Float32Array };
    floatToInt16(f: Float32Array): Int16Array;
    rms(f: Float32Array): number;
    FrameAssembler: new (n?: number) => { push(x: Int16Array): Int16Array[] };
    downsampleTo16k(f: Float32Array, rate: number): Float32Array;
  };
  var OverlayState: any; // overlay-state.js reducer (pure, unit-tested separately)
  var BudgetView: any; // budget-view.js renderer helpers (unit-tested separately)
}
