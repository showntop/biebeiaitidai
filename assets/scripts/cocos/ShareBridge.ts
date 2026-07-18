import type { ShareCardModel, SharePayload } from '../core/SocialChallenge';

export type ShareOutcome = 'shared' | 'copied' | 'unavailable' | 'canceled';

interface DrawContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

interface PortableCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): DrawContext | null;
  toDataURL?(type?: string, quality?: number): string;
  toTempFilePathSync?(options?: { fileType?: 'png' | 'jpg'; quality?: number }): string;
}

interface WechatShareApi {
  createOffscreenCanvas?(options: { type: '2d'; width: number; height: number }): PortableCanvas;
  shareAppMessage(options: {
    title: string;
    query: string;
    imageUrl?: string;
    success?: () => void;
    fail?: (error?: { errMsg?: string }) => void;
  }): void;
}

/** 生成 5:4 暖纸质战报图。Web 输出 data URL；小游戏优先输出本地临时文件。 */
export function renderSharePoster(card: ShareCardModel): string | undefined {
  const width = 600;
  const height = 480;
  const global = globalThis as unknown as {
    document?: Document;
    wx?: WechatShareApi;
  };
  let canvas: PortableCanvas | null = null;
  if (global.wx?.createOffscreenCanvas) {
    canvas = global.wx.createOffscreenCanvas({ type: '2d', width, height });
  } else if (global.document?.createElement) {
    const domCanvas = global.document.createElement('canvas');
    domCanvas.width = width;
    domCanvas.height = height;
    canvas = domCanvas as unknown as PortableCanvas;
  }
  const ctx = canvas?.getContext('2d') ?? null;
  if (!canvas || !ctx) return undefined;
  paintPoster(ctx, card, width, height);
  try {
    return canvas.toTempFilePathSync?.({ fileType: 'jpg', quality: 0.92 })
      ?? canvas.toDataURL?.('image/jpeg', 0.92);
  } catch {
    return undefined;
  }
}

export class ShareBridge {
  async share(payload: SharePayload): Promise<ShareOutcome> {
    const imageUrl = renderSharePoster(payload.card);
    const global = globalThis as unknown as {
      wx?: WechatShareApi;
      navigator?: Navigator & { clipboard?: Clipboard };
      location?: Location;
    };
    if (global.wx?.shareAppMessage) {
      return new Promise((resolve) => {
        global.wx!.shareAppMessage({
          title: payload.title,
          query: payload.query,
          imageUrl,
          success: () => resolve('shared'),
          fail: (error) => resolve(error?.errMsg?.includes('cancel') ? 'canceled' : 'unavailable'),
        });
      });
    }

    const base = global.location ? `${global.location.origin}${global.location.pathname}` : '';
    const url = base ? `${base}?${payload.query}` : payload.query;
    const nav = global.navigator;
    if (nav?.share) {
      try {
        await nav.share({ title: payload.title, text: payload.card.subtitle, url });
        return 'shared';
      } catch {
        return 'canceled';
      }
    }
    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(`${payload.title}\n${url}`);
        return 'copied';
      } catch {
        return 'unavailable';
      }
    }
    return 'unavailable';
  }
}

function paintPoster(ctx: DrawContext, card: ShareCardModel, width: number, height: number): void {
  const accent = card.variant === 'hunt'
    ? '#E29A35'
    : card.variant === 'comeback'
      ? '#3C91D8'
      : card.variant === 'survive'
        ? '#51A36B'
        : '#A77C58';
  ctx.fillStyle = '#F3EBDD';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(79,62,43,.14)';
  roundRect(ctx, 34, 36, width - 68, height - 62, 34);
  ctx.fill();
  ctx.fillStyle = '#FFFBF3';
  ctx.strokeStyle = '#D7C9B8';
  ctx.lineWidth = 3;
  roundRect(ctx, 28, 28, width - 56, height - 62, 34);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accent;
  roundRect(ctx, 62, 62, 178, 38, 19);
  ctx.fill();
  ctx.fillStyle = '#FFFDF8';
  ctx.font = 'bold 20px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(card.eyebrow, 151, 81, 160);

  ctx.fillStyle = '#342B25';
  ctx.font = 'bold 42px "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(card.title, 62, 148, width - 124);
  ctx.fillStyle = '#7D7063';
  ctx.font = '24px "PingFang SC", sans-serif';
  ctx.fillText(card.subtitle, 62, 194, width - 124);

  const gap = 14;
  const chipW = (width - 124 - gap * 2) / 3;
  card.metrics.forEach((metric, index) => {
    const x = 62 + index * (chipW + gap);
    ctx.fillStyle = '#F3EBDD';
    ctx.strokeStyle = '#D7C9B8';
    ctx.lineWidth = 2;
    roundRect(ctx, x, 238, chipW, 112, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#7D7063';
    ctx.font = '20px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(metric.label, x + chipW / 2, 270, chipW - 20);
    ctx.fillStyle = accent;
    ctx.font = 'bold 34px "PingFang SC", sans-serif';
    ctx.fillText(metric.value, x + chipW / 2, 318, chipW - 20);
  });

  ctx.fillStyle = '#8D8174';
  ctx.font = '20px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(card.footer, width / 2, 396, width - 100);
  ctx.fillStyle = accent;
  roundRect(ctx, 190, 427, 220, 8, 4);
  ctx.fill();
}

function roundRect(ctx: DrawContext, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
