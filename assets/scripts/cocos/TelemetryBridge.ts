import { sys } from 'cc';
import { CompositeTelemetrySink, RunTelemetry } from '../core/Telemetry';
import type { TelemetryEvent, TelemetrySink } from '../core/Telemetry';

const STORAGE_KEY = 'braatn_telemetry_v1';
const MAX_EVENTS = 400;

interface WxSystemInfo {
  benchmarkLevel?: number;
  platform?: string;
  system?: string;
}

type DeliveryValue = string | number;
type DeliveryPayload = Record<string, DeliveryValue>;

interface HostAnalytics {
  track(eventName: string, payload: DeliveryPayload): void;
  flush?(): void;
}

interface WxAnalyticsApi {
  reportEvent?: (eventId: string, data: DeliveryPayload) => void;
  reportAnalytics?: (eventName: string, data: DeliveryPayload) => void;
}

/**
 * 正式分析出口：宿主注入的 SDK 优先，其次使用微信原生自定义事件。
 *
 * 第三方 SDK 只需在启动阶段注入：
 * globalThis.__BRAATN_ANALYTICS__ = { track(name, payload), flush?() }
 * 玩法层和 RunTelemetry 无需感知最终选择的是神策、GrowingIO 还是自建服务。
 */
export class PlatformTelemetrySink implements TelemetrySink {
  private delivered = 0;
  private failed = 0;

  emit(event: TelemetryEvent): void {
    const host = (globalThis as unknown as { __BRAATN_ANALYTICS__?: HostAnalytics }).__BRAATN_ANALYTICS__;
    const payload = deliveryPayload(event);
    try {
      if (host?.track) {
        host.track(event.name, payload);
        this.delivered++;
        return;
      }
      const wxApi = (globalThis as unknown as { wx?: WxAnalyticsApi }).wx;
      if (wxApi?.reportEvent) {
        wxApi.reportEvent(event.name, payload);
        this.delivered++;
        return;
      }
      if (wxApi?.reportAnalytics) {
        wxApi.reportAnalytics(event.name, payload);
        this.delivered++;
      }
    } catch {
      this.failed++;
    }
  }

  flush(): void {
    const host = (globalThis as unknown as { __BRAATN_ANALYTICS__?: HostAnalytics }).__BRAATN_ANALYTICS__;
    try { host?.flush?.(); } catch { this.failed++; }
  }

  get status(): { delivered: number; failed: number; channel: 'host-sdk' | 'wechat-native' | 'local-only' } {
    const host = (globalThis as unknown as { __BRAATN_ANALYTICS__?: HostAnalytics }).__BRAATN_ANALYTICS__;
    const wxApi = (globalThis as unknown as { wx?: WxAnalyticsApi }).wx;
    return {
      delivered: this.delivered,
      failed: this.failed,
      channel: host?.track ? 'host-sdk' : wxApi?.reportEvent || wxApi?.reportAnalytics ? 'wechat-native' : 'local-only',
    };
  }
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

export function createTelemetryBridge(qaMode: boolean): { telemetry: RunTelemetry; sink: LocalTelemetrySink; platformSink: PlatformTelemetrySink } {
  const platform = platformInfo();
  const sink = new LocalTelemetrySink(!qaMode);
  const platformSink = new PlatformTelemetrySink();
  const deliverySink = qaMode ? sink : new CompositeTelemetrySink([sink, platformSink]);
  const sessionId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  const telemetry = new RunTelemetry(deliverySink, {
    sessionId,
    platform: platform.name,
    deviceTier: platform.tier,
    appVersion: '0.1.0',
  });
  publishDeliveryStatus(platformSink);
  return { telemetry, sink, platformSink };
}

function deliveryPayload(event: TelemetryEvent): DeliveryPayload {
  const payload: DeliveryPayload = {
    timestamp_ms: event.timestampMs,
    sequence: event.sequence,
    session_id: event.sessionId,
    run_id: event.runId ?? '',
    level_index: event.levelIndex ?? -1,
    platform: event.platform,
    device_tier: event.deviceTier,
  };
  for (const [key, value] of Object.entries(event.payload)) {
    payload[key] = value === null ? '' : typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return payload;
}

function publishDeliveryStatus(platformSink: PlatformTelemetrySink): void {
  const api = { status: () => platformSink.status };
  (globalThis as unknown as { __BRAATN_TELEMETRY_DELIVERY__: typeof api }).__BRAATN_TELEMETRY_DELIVERY__ = api;
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
