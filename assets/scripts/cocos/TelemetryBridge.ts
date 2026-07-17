import { sys } from 'cc';
import { RunTelemetry } from '../core/Telemetry';
import type { TelemetryEvent, TelemetrySink } from '../core/Telemetry';

const STORAGE_KEY = 'braatn_telemetry_v1';
const MAX_EVENTS = 400;

interface WxSystemInfo {
  benchmarkLevel?: number;
  platform?: string;
  system?: string;
}

/** 本地环形日志先保证事件可验收；接正式数据 SDK 时只需替换 TelemetrySink。 */
export class LocalTelemetrySink implements TelemetrySink {
  private events: TelemetryEvent[];

  constructor(private readonly persist: boolean) {
    this.events = persist ? this.read() : [];
    this.publishDebugApi();
  }

  emit(event: TelemetryEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    if (event.name === 'level_end' || event.name === 'return_home') this.flush();
  }

  flush(): void {
    if (!this.persist) return;
    try {
      sys.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.events));
    } catch {
      // 埋点永远不能阻断游戏。
    }
  }

  snapshot(): TelemetryEvent[] {
    return this.events.slice();
  }

  clear(): void {
    this.events = [];
    if (this.persist) sys.localStorage?.removeItem(STORAGE_KEY);
  }

  private read(): TelemetryEvent[] {
    try {
      const raw = sys.localStorage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) as TelemetryEvent[] : [];
    } catch {
      return [];
    }
  }

  private publishDebugApi(): void {
    const api = {
      dump: () => this.snapshot(),
      clear: () => this.clear(),
      flush: () => this.flush(),
    };
    (globalThis as unknown as { __BRAATN_TELEMETRY__: typeof api }).__BRAATN_TELEMETRY__ = api;
  }
}

export function createTelemetryBridge(qaMode: boolean): { telemetry: RunTelemetry; sink: LocalTelemetrySink } {
  const platform = platformInfo();
  const sink = new LocalTelemetrySink(!qaMode);
  const sessionId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  const telemetry = new RunTelemetry(sink, {
    sessionId,
    platform: platform.name,
    deviceTier: platform.tier,
    appVersion: '0.1.0',
  });
  return { telemetry, sink };
}

function platformInfo(): { name: string; tier: string } {
  const wxApi = (globalThis as {
    wx?: { getSystemInfoSync?: () => WxSystemInfo };
  }).wx;
  if (wxApi?.getSystemInfoSync) {
    try {
      const info = wxApi.getSystemInfoSync();
      const score = info.benchmarkLevel ?? -1;
      const tier = score < 0 ? 'unknown' : score >= 30 ? 'high' : score >= 15 ? 'mid' : 'low';
      return { name: `wechat-${info.platform ?? 'unknown'}`, tier };
    } catch {
      return { name: 'wechat-unknown', tier: 'unknown' };
    }
  }

  const nav = (globalThis as { navigator?: Navigator & { deviceMemory?: number } }).navigator;
  const cores = nav?.hardwareConcurrency ?? 0;
  const memory = nav?.deviceMemory ?? 0;
  const tier = cores >= 8 && (memory === 0 || memory >= 4)
    ? 'high'
    : cores >= 4
      ? 'mid'
      : cores > 0
        ? 'low'
        : 'unknown';
  return { name: sys.isBrowser ? 'web' : 'native', tier };
}
