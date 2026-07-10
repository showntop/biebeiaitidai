#!/usr/bin/env python3
"""
bg-office.png 图片手术脚本

在原始 AI 生成的背景图上"插入墙面+细支架竖条"，撑大显示器和桌面之间的间距。
原画美术质感完全保留，只插入纯墙色+同款支架竖条。

用法：python3 scripts/surgery-bg.ts
输出：assets/resources/art/bg/bg-office.png

改完图后记得更新 GameRunner.ts 里的 BG_SCREEN_TOP/BOTTOM/DESK_TOP 常量。
可以用 python3 scripts/measure-bg.ts 自动测量并生成常量。

=== 可调参数（改这里）===

INSERT_PX    : 插入多少像素的墙面（越大=支架越长、间距越大）
               原画间距 133px，当前 INSERT_PX=100 → 总间距 233px
CROP_TOP     : 从图片顶部裁掉多少像素（墙上方有 389px 余量可裁）
               裁得越多 → 显示器和桌面都往上移
CROP_BOTTOM  : 从图片底部裁掉多少像素（桌面下方有 782px 余量可裁）
               约束：CROP_TOP + CROP_BOTTOM = INSERT_PX（保持总高 1920）
STAND_HALF_W : 支架竖条半宽（像素），原画约 10px
"""
from PIL import Image
import numpy as np

# ===================== 可调参数（改这里）=====================
INSERT_PX = 100       # 插入墙面高度（原画间距133px，插入后总间距=133+INSERT_PX）
CROP_TOP = 150        # 顶部裁剪（越大=整体上移越多，墙上方有389px余量）
STAND_HALF_W = 6      # 支架竖条半宽（原画约10px，改小=支架更细）
# =============================================================

# 原图关键位置（像素实测，不要改）
SCREEN_BOTTOM = 1005   # 显示器屏幕底部 y
DESK_LINE = 1138       # 桌面线 y
ORIGINAL = '/tmp/bg-office-original.png'  # git 恢复的原图
OUTPUT = 'assets/resources/art/bg/bg-office.png'

# CROP_BOTTOM 自动算（保持总高=原图高度）
CROP_BOTTOM = INSERT_PX - CROP_TOP  # 可能为负=底部补墙色


def main():
    img = Image.open(ORIGINAL).convert('RGB')
    arr = np.array(img)
    W, H = img.size
    print(f'原图: {W}x{H}')

    # 采样墙色和支架色
    wall = tuple(arr[200, W // 2])
    stand_cx = W // 2
    stand_color = tuple(arr[1080, stand_cx])
    print(f'墙色={wall}  支架色={stand_color}  支架中心x={stand_cx}  半宽={STAND_HALF_W}')

    # 构建插入条：纯墙色 + 中间支架竖条
    insert = np.tile(np.array(wall, dtype=np.uint8), (INSERT_PX, W, 1))
    insert[:, stand_cx - STAND_HALF_W: stand_cx + STAND_HALF_W, :] = \
        np.array(stand_color, dtype=np.uint8)

    # 分割原图
    top = arr[:SCREEN_BOTTOM, :, :]                    # 屏幕+上方墙
    stand_orig = arr[SCREEN_BOTTOM:DESK_LINE, :, :]    # 原画支架（不拉伸）
    bottom = arr[DESK_LINE:, :, :]                     # 桌面+下方

    # 拼接
    new = np.vstack([top, insert, stand_orig, bottom])
    # 裁剪/补墙到原高度
    if CROP_BOTTOM >= 0:
        new = new[CROP_TOP: CROP_TOP + H, :, :]
    else:
        # CROP_BOTTOM < 0：顶部裁多了，底部补墙色
        new = new[CROP_TOP:, :, :]
        pad_h = H - new.shape[0]
        if pad_h > 0:
            pad = np.tile(np.array(wall, dtype=np.uint8), (pad_h, W, 1))
            new = np.vstack([new, pad])

    Image.fromarray(new).save(OUTPUT)
    print(f'输出: {OUTPUT} ({W}x{H})')
    print(f'插入{INSERT_PX}px墙面，裁顶部{CROP_TOP}px，裁底部{CROP_BOTTOM}px')

    # 自动验证
    dark = (new[:, :, 0] < 100) & (new[:, :, 1] < 100) & (new[:, :, 2] < 100)
    rr = dark.sum(axis=1) / W
    segs = []
    s = None
    for y in range(H):
        if rr[y] > 0.5:
            if s is None:
                s = y
        else:
            if s is not None and y - s > 20:
                segs.append((s, y - 1))
            s = None
    if s is not None and H - s > 20:
        segs.append((s, H - 1))
    sc = max(segs, key=lambda x: x[1] - x[0])
    dw = ((new[:, :, 0] < 130) & (new[:, :, 1] < 130) & (new[:, :, 2] < 130)).sum(axis=1) / W
    desk_y = None
    for y in range(sc[1] + 1, H):
        if dw[y] > 0.4:
            desk_y = y
            break

    gap_px = desk_y - sc[1]
    print(f'\n=== 结果 ===')
    print(f'屏幕: {sc[0]/H*100:.1f}%-{sc[1]/H*100:.1f}%')
    print(f'桌面: {desk_y/H*100:.1f}%')
    print(f'间距: {gap_px}px ({gap_px/H*100:.1f}%)')
    print(f'支架总高: {gap_px}px (原画133px)')

    # 手机模拟
    scale = 375 / W
    gap_screen = gap_px * scale
    max_char = gap_screen / 0.527
    print(f'\n375px手机模拟: 间距={gap_screen:.0f}px, 最大角色={max_char:.0f}px ({max_char/375*100:.0f}%屏宽)')

    # 生成 GameRunner 常量
    print(f'\n=== GameRunner.ts 常量 ===')
    print(f'  private static readonly BG_SCREEN_TOP = {sc[0]/H:.3f};')
    print(f'  private static readonly BG_SCREEN_BOTTOM = {sc[1]/H:.3f};')
    print(f'  private static readonly BG_SCREEN_LEFT = 0.066;')
    print(f'  private static readonly BG_SCREEN_RIGHT = 0.932;')
    print(f'  private static readonly BG_DESK_TOP = {desk_y/H:.3f};')


if __name__ == '__main__':
    main()
