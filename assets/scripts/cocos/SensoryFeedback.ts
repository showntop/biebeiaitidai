import { sys } from 'cc';
import type { PropType } from '../core/types';

export type FeedbackCue =
  | 'press'
  | 'pickup'
  | 'target-tick'
  | 'target-lock'
  | 'release-add'
  | 'release-change'
  | 'release-pot'
  | 'release-kiss'
  | 'hit'
  | 'heavy-hit'
  | 'shield-break'
  | 'link-break'
  | 'boss-impact'
  | 'last-chance'
  | 'perfect'
  | 'miss'
  | 'danger'
  | 'boss'
  | 'revive'
  | 'win'
  | 'lose';

export type HapticStrength = 'light' | 'medium' | 'heavy';

interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  exponentialRampToValueAtTime(value: number, time: number): void;
}

interface OscillatorLike {
  type: string;
  frequency: AudioParamLike;
  connect(node: unknown): void;
  start(time?: number): void;
  stop(time?: number): void;
}

interface GainLike {
  gain: AudioParamLike;
  connect(node: unknown): void;
}

interface AudioContextLike {
  currentTime: number;
  destination: unknown;
  state?: string;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

interface Tone {
  at: number;
  duration: number;
  from: number;
  to: number;
  gain: number;
  wave: 'sine' | 'triangle' | 'square';
}

const SETTINGS_KEY = 'braatn_feedback_v1';

/**
 * 轻量程序化音效 + 可关闭震动。没有网络请求和音频解码，首触即可播放，微信/浏览器均按能力降级。
 */
export class SensoryFeedback {
  private context: AudioContextLike | null = null;
  private soundEnabled = true;
  private hapticsEnabled = true;
  private lastCueAt = new Map<FeedbackCue, number>();
  private lastHapticAt = 0;

  constructor() {
    this.loadSettings();
    this.publishSettingsApi();
  }

  unlock(): void {
    const context = this.ensureContext();
    if (context?.state === 'suspended') {
      try { void context.resume?.(); } catch { /* 不阻断输入 */ }
    }
  }

  play(cue: FeedbackCue): void {
    if (!this.soundEnabled) return;
    const nowMs = Date.now();
    const minGap = cue === 'target-tick' ? 70
      : cue === 'boss' || cue === 'danger' || cue === 'boss-impact' || cue === 'last-chance' ? 260
        : 28;
    if (nowMs - (this.lastCueAt.get(cue) ?? 0) < minGap) return;
    this.lastCueAt.set(cue, nowMs);
    const context = this.ensureContext();
    if (!context) return;
    try {
      const start = context.currentTime + 0.004;
      for (const tone of tonesFor(cue)) this.scheduleTone(context, start, tone);
    } catch {
      // 音效失败不能影响游戏判定或拖动帧率。
    }
  }

  playRelease(prop: PropType): void {
    const cue: FeedbackCue = prop === 'change-demand'
      ? 'release-change'
      : prop === 'throw-pot'
        ? 'release-pot'
        : prop === 'kiss-up'
          ? 'release-kiss'
          : 'release-add';
    this.play(cue);
  }

  haptic(strength: HapticStrength, minIntervalMs = 65): void {
    if (!this.hapticsEnabled) return;
    const now = Date.now();
    if (now - this.lastHapticAt < minIntervalMs) return;
    this.lastHapticAt = now;
    const wxApi = (globalThis as {
      wx?: { vibrateShort?: (options: { type: HapticStrength }) => void };
    }).wx;
    if (wxApi?.vibrateShort) {
      try { wxApi.vibrateShort({ type: strength }); } catch { /* 能力降级 */ }
      return;
    }
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const duration = strength === 'heavy' ? 28 : strength === 'medium' ? 18 : 10;
    try { nav?.vibrate?.(duration); } catch { /* 能力降级 */ }
  }

  get settings(): { soundEnabled: boolean; hapticsEnabled: boolean } {
    return { soundEnabled: this.soundEnabled, hapticsEnabled: this.hapticsEnabled };
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    this.saveSettings();
  }

  setHapticsEnabled(enabled: boolean): void {
    this.hapticsEnabled = enabled;
    this.saveSettings();
  }

  dispose(): void {
    try { void this.context?.close?.(); } catch { /* ignore */ }
    this.context = null;
  }

  private ensureContext(): AudioContextLike | null {
    if (this.context) return this.context;
    const wxApi = (globalThis as {
      wx?: { createWebAudioContext?: () => AudioContextLike };
    }).wx;
    if (wxApi?.createWebAudioContext) {
      try {
        this.context = wxApi.createWebAudioContext();
        return this.context;
      } catch {
        return null;
      }
    }
    const scope = globalThis as unknown as {
      AudioContext?: new () => AudioContextLike;
      webkitAudioContext?: new () => AudioContextLike;
    };
    const AudioCtor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      this.context = new AudioCtor();
      return this.context;
    } catch {
      return null;
    }
  }

  private scheduleTone(context: AudioContextLike, start: number, tone: Tone): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const at = start + tone.at;
    const end = at + tone.duration;
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.from, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, tone.to), end);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(tone.gain, at + Math.min(0.018, tone.duration * 0.25));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(end + 0.01);
  }

  private loadSettings(): void {
    try {
      const raw = sys.localStorage?.getItem(SETTINGS_KEY);
      if (!raw) return;
      const value = JSON.parse(raw) as { soundEnabled?: unknown; hapticsEnabled?: unknown };
      if (typeof value.soundEnabled === 'boolean') this.soundEnabled = value.soundEnabled;
      if (typeof value.hapticsEnabled === 'boolean') this.hapticsEnabled = value.hapticsEnabled;
    } catch {
      // 损坏设置回退默认开启。
    }
  }

  private saveSettings(): void {
    try { sys.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  private publishSettingsApi(): void {
    const api = {
      settings: () => this.settings,
      setSoundEnabled: (enabled: boolean) => this.setSoundEnabled(enabled),
      setHapticsEnabled: (enabled: boolean) => this.setHapticsEnabled(enabled),
      preview: (cue: FeedbackCue) => { this.unlock(); this.play(cue); },
    };
    (globalThis as unknown as { __BRAATN_FEEDBACK__: typeof api }).__BRAATN_FEEDBACK__ = api;
  }
}

function tonesFor(cue: FeedbackCue): Tone[] {
  const t = (at: number, duration: number, from: number, to: number, gain: number, wave: Tone['wave'] = 'triangle'): Tone => ({
    at, duration, from, to, gain, wave,
  });
  switch (cue) {
    case 'press': return [t(0, 0.045, 250, 205, 0.025)];
    case 'pickup': return [t(0, 0.07, 310, 440, 0.035), t(0.055, 0.06, 440, 520, 0.022)];
    case 'target-tick': return [t(0, 0.025, 610, 560, 0.012, 'sine')];
    case 'target-lock': return [t(0, 0.07, 660, 860, 0.038, 'sine'), t(0.055, 0.10, 990, 1180, 0.026, 'sine')];
    case 'release-add': return [t(0, 0.12, 430, 260, 0.042)];
    case 'release-change': return [t(0, 0.15, 520, 310, 0.038), t(0.025, 0.10, 780, 460, 0.020, 'sine')];
    case 'release-pot': return [t(0, 0.13, 220, 90, 0.055, 'square')];
    case 'release-kiss': return [t(0, 0.10, 540, 720, 0.032, 'sine'), t(0.07, 0.12, 720, 980, 0.026, 'sine')];
    case 'hit': return [t(0, 0.09, 210, 125, 0.050, 'square')];
    case 'heavy-hit': return [t(0, 0.16, 145, 55, 0.065, 'square'), t(0.03, 0.10, 300, 120, 0.025)];
    case 'shield-break': return [t(0, 0.07, 1160, 720, 0.034, 'sine'), t(0.035, 0.12, 840, 230, 0.046, 'square')];
    case 'link-break': return [t(0, 0.065, 620, 390, 0.034), t(0.09, 0.08, 440, 740, 0.030, 'sine')];
    case 'boss-impact': return [t(0, 0.28, 105, 42, 0.068, 'square'), t(0.05, 0.16, 330, 95, 0.035), t(0.18, 0.20, 82, 38, 0.052, 'square')];
    case 'last-chance': return [t(0, 0.09, 240, 170, 0.055, 'square'), t(0.12, 0.09, 300, 205, 0.058, 'square'), t(0.24, 0.16, 390, 135, 0.064, 'square')];
    case 'perfect': return [t(0, 0.12, 660, 760, 0.045, 'sine'), t(0.07, 0.14, 880, 1040, 0.04, 'sine'), t(0.14, 0.18, 1100, 1320, 0.035, 'sine')];
    case 'miss': return [t(0, 0.16, 190, 105, 0.027, 'sine')];
    case 'danger': return [t(0, 0.11, 185, 145, 0.045, 'square'), t(0.15, 0.11, 185, 145, 0.045, 'square')];
    case 'boss': return [t(0, 0.24, 120, 65, 0.060, 'square'), t(0.13, 0.22, 95, 48, 0.055, 'square')];
    case 'revive': return [t(0, 0.12, 392, 523, 0.040), t(0.09, 0.14, 523, 659, 0.040), t(0.18, 0.18, 659, 880, 0.035)];
    case 'win': return [t(0, 0.14, 523, 587, 0.04), t(0.11, 0.16, 659, 740, 0.04), t(0.23, 0.24, 784, 988, 0.045)];
    case 'lose': return [t(0, 0.18, 247, 208, 0.045), t(0.13, 0.20, 196, 165, 0.042), t(0.28, 0.28, 147, 98, 0.045)];
  }
}
