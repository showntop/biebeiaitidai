import type { RunTelemetry } from '../core/Telemetry';

interface WxLifecycleApi {
  onError?(handler: (message: string) => void): void;
  offError?(handler: (message: string) => void): void;
  onUnhandledRejection?(handler: (event: { reason?: unknown }) => void): void;
  offUnhandledRejection?(handler: (event: { reason?: unknown }) => void): void;
  onHide?(handler: () => void): void;
  offHide?(handler: () => void): void;
  onShow?(handler: () => void): void;
  offShow?(handler: () => void): void;
}

/** 只采集去标识化的错误类别和短消息，不采集 openid、URL query 或完整堆栈。 */
export class RuntimeMonitor {
  private stalled = false;
  private readonly onWindowError = (event: ErrorEvent) => this.signal('uncaught-error', event.message);
  private readonly onWindowRejection = (event: PromiseRejectionEvent) => this.signal('unhandled-rejection', stringifyReason(event.reason));
  private readonly onWxError = (message: string) => this.signal('uncaught-error', message);
  private readonly onWxRejection = (event: { reason?: unknown }) => this.signal('unhandled-rejection', stringifyReason(event.reason));
  private readonly onHide = () => this.signal('app-background');
  private readonly onShow = () => this.signal('app-foreground');
  private wxApi: WxLifecycleApi | null = null;

  constructor(private readonly telemetry: RunTelemetry) {}

  start(): void {
    const global = globalThis as unknown as {
      addEventListener?: (name: string, handler: EventListener) => void;
      wx?: WxLifecycleApi;
    };
    global.addEventListener?.('error', this.onWindowError as EventListener);
    global.addEventListener?.('unhandledrejection', this.onWindowRejection as EventListener);
    this.wxApi = global.wx ?? null;
    this.wxApi?.onError?.(this.onWxError);
    this.wxApi?.onUnhandledRejection?.(this.onWxRejection);
    this.wxApi?.onHide?.(this.onHide);
    this.wxApi?.onShow?.(this.onShow);
  }

  dispose(): void {
    const global = globalThis as unknown as { removeEventListener?: (name: string, handler: EventListener) => void };
    global.removeEventListener?.('error', this.onWindowError as EventListener);
    global.removeEventListener?.('unhandledrejection', this.onWindowRejection as EventListener);
    this.wxApi?.offError?.(this.onWxError);
    this.wxApi?.offUnhandledRejection?.(this.onWxRejection);
    this.wxApi?.offHide?.(this.onHide);
    this.wxApi?.offShow?.(this.onShow);
    this.wxApi = null;
  }

  observeFrame(dtSec: number): void {
    if (dtSec >= 1.5 && !this.stalled) {
      this.stalled = true;
      this.signal('frame-stall', `${Math.round(dtSec * 1000)}ms`);
    } else if (dtSec < 0.5) {
      this.stalled = false;
    }
  }

  assetLoadFailure(assetName: string): void {
    this.signal('asset-load-failure', assetName.replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 80));
  }

  private signal(kind: string, rawDetail?: string): void {
    this.telemetry.runtimeSignal(kind, sanitize(rawDetail));
  }
}

function stringifyReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : 'unknown';
}

function sanitize(message: string | undefined): string | null {
  if (!message) return null;
  return message
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/openid[=:]\s*[^\s,]+/gi, 'openid=[redacted]')
    .slice(0, 160);
}
