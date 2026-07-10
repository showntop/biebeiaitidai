#!/usr/bin/env python3
"""
背景图比例验收 & 校准脚本

用法：python3 scripts/measure-bg.ts [path/to/bg-office.png]

输出 GameRunner.ts 中需要更新的比例常量（BG_SCREEN_TOP/BOTTOM/LEFT/RIGHT/DESK_TOP），
以及角色 fit 计算结果（验证头顶是否穿入屏幕）。

依赖：Pillow + numpy (pip install Pillow numpy)
"""
import sys
import numpy as np
from PIL import Image

def measure_bg(path):
    img = Image.open(path).convert('RGB')
    arr = np.array(img)
    h, w, _ = arr.shape
    print(f'Image: {w}x{h} ({w/h:.4f} ratio)')

    # 暗色像素（显示器屏幕 < 100）
    dark = (arr[:,:,0] < 100) & (arr[:,:,1] < 100) & (arr[:,:,2] < 100)
    row_ratio = dark.sum(axis=1) / w

    # 找屏幕区域（暗色行占比 > 50%），取最长的连续段作为屏幕
    screen_rows = [y for y in range(h) if row_ratio[y] > 0.5]
    if not screen_rows:
        print('ERROR: 找不到显示器屏幕区域（暗色行 >50%）')
        return

    # 拆成连续段，取最长的
    segments = []
    seg_start = screen_rows[0]
    prev = screen_rows[0]
    for y in screen_rows[1:]:
        if y - prev > 5:
            segments.append((seg_start, prev))
            seg_start = y
        prev = y
    segments.append((seg_start, prev))
    largest_seg = max(segments, key=lambda s: s[1] - s[0])
    screen_top = largest_seg[0]
    screen_bottom = largest_seg[1]

    # 屏幕左右边界
    mid_y = (screen_top + screen_bottom) // 2
    row = dark[mid_y]
    xs = np.where(row)[0]
    screen_left = xs[0]
    screen_right = xs[-1]

    # 桌面线：找屏幕底部之后第一条横贯全图的黑色描边线（暗色行占比 > 40%，宽阈值 <130）
    dark_wide = (arr[:,:,0] < 130) & (arr[:,:,1] < 130) & (arr[:,:,2] < 130)
    row_ratio_wide = dark_wide.sum(axis=1) / w
    desk_line = None
    for y in range(screen_bottom + 1, h):
        if row_ratio_wide[y] > 0.4:
            desk_line = y
            break

    if desk_line is None:
        # 回退：找墙面色变桌面棕色的分界（沿多个 x 位置扫描）
        for y in range(screen_bottom + 1, h):
            hits = 0
            for x_test in range(150, w - 100, 100):
                col = arr[y, x_test].astype(int)
                if abs(col[0] - 178) < 30 and abs(col[1] - 129) < 30 and abs(col[2] - 88) < 30:
                    hits += 1
            if hits >= 3:
                desk_line = y
                break

    if desk_line is None:
        print('ERROR: 找不到桌面线（黑色描边线 或 棕色桌面）')
        return

    gap_pct = (desk_line - screen_bottom) / h * 100

    print(f'\n=== 测量结果 ===')
    print(f'屏幕顶部:   y={screen_top:4d}  ({screen_top/h*100:.1f}%)')
    print(f'屏幕底部:   y={screen_bottom:4d}  ({screen_bottom/h*100:.1f}%)')
    print(f'屏幕左边界: x={screen_left:4d}  ({screen_left/w*100:.1f}%)')
    print(f'屏幕右边界: x={screen_right:4d}  ({screen_right/w*100:.1f}%)')
    print(f'桌面线:     y={desk_line:4d}  ({desk_line/h*100:.1f}%)')
    print(f'屏幕底→桌面间距: {gap_pct:.1f}%  {("(OK >=20%)" if gap_pct >= 20 else "(不足! 需重新生成 >=20%)")}')

    print(f'\n=== GameRunner.ts 常量（复制粘贴） ===')
    print(f'  private static readonly BG_SCREEN_TOP = {screen_top/h:.3f};')
    print(f'  private static readonly BG_SCREEN_BOTTOM = {screen_bottom/h:.3f};')
    print(f'  private static readonly BG_SCREEN_LEFT = {screen_left/w:.3f};')
    print(f'  private static readonly BG_SCREEN_RIGHT = {screen_right/w:.3f};')
    print(f'  private static readonly BG_DESK_TOP = {desk_line/h:.3f};')

    # 角色 fit 验证
    print(f'\n=== 角色 fit 验证 ===')
    # 固定路径查找 char-back.png，不从 bg 路径推导
    import os
    candidates = [
        'assets/resources/art/chars/char-back.png',
        os.path.join(os.path.dirname(os.path.dirname(path)), 'chars', 'char-back.png'),
    ]
    char_path = None
    for c in candidates:
        if os.path.exists(c):
            char_path = c
            break
    if char_path is None:
        # 用硬编码的已知比例做近似验证
        print('(找不到 char-back.png，用已知比例近似验证)')
        head_to_kb_ratio = 0.527  # 实测：头顶3.3%，键盘前沿56.0%，差52.7%
        gap_px = desk_line - screen_bottom
        for w_ratio in [0.56, 0.45, 0.35]:
            char_h = w_ratio * w
            head_kb_display = head_to_kb_ratio * char_h
            fit = head_kb_display <= gap_px
            status = "OK" if fit else f"FAIL (穿入{head_kb_display - gap_px:.0f}px)"
            print(f'  屏宽{int(w_ratio*100)}%: 角色高{char_h:.0f}px, 头到键盘{head_kb_display:.0f}px, 间距{gap_px}px → {status}')
    else:
        try:
            char_img = Image.open(char_path).convert('RGBA')
            c_arr = np.array(char_img)
            ch, cw, _ = c_arr.shape
            alpha = c_arr[:, :, 3]
            mask = alpha > 128
            char_rows = np.where(mask.sum(axis=1) > 3)[0]
            head_top = char_rows[0]
            widths = [mask[y].sum() for y in range(ch)]
            max_w_y = widths.index(max(widths))
            kb_front = max_w_y
            for y in range(max_w_y, ch):
                if widths[y] < max(widths) * 0.7:
                    kb_front = y
                    break

            head_to_kb = (kb_front - head_top) / ch
            gap_px = desk_line - screen_bottom

            print(f'角色图: {cw}x{ch} ({char_path})')
            print(f'头顶: y={head_top} ({head_top/ch*100:.1f}%)')
            print(f'键盘前沿: y={kb_front} ({kb_front/ch*100:.1f}%)')
            print(f'头→键盘距离: {head_to_kb*100:.1f}% 的角色高度')
            for w_ratio in [0.56, 0.45, 0.35]:
                char_h = w_ratio * w
                head_kb_display = head_to_kb * char_h
                fit = head_kb_display <= gap_px
                status = "OK" if fit else f"FAIL (穿入{head_kb_display - gap_px:.0f}px)"
                print(f'  屏宽{int(w_ratio*100)}%: 角色高{char_h:.0f}px, 头到键盘{head_kb_display:.0f}px, 间距{gap_px}px → {status}')
        except Exception as e:
            print(f'(角色验证失败: {e})')


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else 'assets/resources/art/bg/bg-office.png'
    measure_bg(path)
