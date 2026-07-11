#!/usr/bin/env python3
"""
方案B：用 Python 按精确比例直接生成 bg-office.png

flat vector 风格本身就是色块矩形，程序画的和 AI 画的没有本质区别。
比例与 GameRunner.ts 常量 100% 一致，无需验收脚本。

用法：python3 scripts/generate-bg.ts
输出：assets/resources/art/bg/bg-office.png (1088×1920)

依赖：Pillow (pip install Pillow)
"""
from PIL import Image, ImageDraw

# === 比例常量（与 GameRunner.ts 保持一致）===
W, H = 1088, 1920  # 9:16 竖屏

# 颜色（与美术指南环境色一致）
WALL_COLOR = (240, 228, 208)      # #F0E4D0 暖米色墙（与现有 bg-office 实测一致）
SCREEN_COLOR = (60, 58, 55)       # #3C3A37 深灰屏幕
BEZEL_COLOR = (90, 88, 85)        # 屏幕边框（比屏幕稍浅）
STAND_COLOR = (60, 58, 55)        # 支架（与屏幕同色）
DESK_COLOR = (168, 124, 88)       # #A87C58 暖棕桌面
DESK_EDGE_COLOR = (140, 100, 70)  # 桌面边缘（稍深）
OUTLINE_COLOR = (40, 35, 30)      # 粗黑描边

# 比例（图片顶部为 0%，底部为 100%）
SCREEN_TOP = 0.06
SCREEN_BOTTOM = 0.22
SCREEN_LEFT = 0.12
SCREEN_RIGHT = 0.88
DESK_TOP = 0.32     # 桌子从 32% 开始（原 42%，提前 10% 让桌面更宽）
DESK_BOTTOM = 0.58  # 桌子到 58%（原 55%，加深让键盘有地方放）
STAND_WIDTH_RATIO = 0.05  # 支架宽度占图片宽度的比例

# 描边宽度
OUTLINE_W = 4


def px(ratio_y, ratio_x=None):
    """比例转像素"""
    y = int(ratio_y * H)
    if ratio_x is not None:
        return int(ratio_x * W), y
    return y


def draw_rect(draw, x1, y1, x2, y2, fill, outline=OUTLINE_COLOR, width=OUTLINE_W):
    """画带描边的矩形"""
    draw.rectangle([x1, y1, x2, y2], fill=fill, outline=outline, width=width)


def main():
    img = Image.new('RGB', (W, H), WALL_COLOR)
    draw = ImageDraw.Draw(img)

    # 1. 整面墙已经是 WALL_COLOR（Image.new 初始色）

    # 2. 显示器屏幕（带边框）
    sx1 = int(SCREEN_LEFT * W)
    sx2 = int(SCREEN_RIGHT * W)
    sy1 = int(SCREEN_TOP * H)
    sy2 = int(SCREEN_BOTTOM * H)

    # 屏幕外框（bezel，比屏幕大一圈）
    bezel_margin = 6
    draw_rect(draw,
              sx1 - bezel_margin, sy1 - bezel_margin,
              sx2 + bezel_margin, sy2 + bezel_margin,
              fill=BEZEL_COLOR)
    # 屏幕本体
    draw_rect(draw,
              sx1, sy1, sx2, sy2,
              fill=SCREEN_COLOR, outline=BEZEL_COLOR, width=2)

    # 3. 显示器支架（从屏幕底部中央连到桌面）
    stand_cx = W // 2
    stand_w = int(W * STAND_WIDTH_RATIO)
    stand_top = sy2 + bezel_margin
    stand_bottom = px(DESK_TOP)

    # 支架颈（竖直条）
    draw_rect(draw,
              stand_cx - stand_w // 2, stand_top,
              stand_cx + stand_w // 2, stand_bottom,
              fill=STAND_COLOR, outline=OUTLINE_COLOR, width=OUTLINE_W)

    # 支架底座（桌面上的扁平梯形/矩形）
    base_w = stand_w * 3
    base_h = 8
    draw_rect(draw,
              stand_cx - base_w // 2, stand_bottom - base_h,
              stand_cx + base_w // 2, stand_bottom,
              fill=STAND_COLOR, outline=OUTLINE_COLOR, width=OUTLINE_W)

    # 4. 桌面
    dy1 = px(DESK_TOP)
    dy2 = px(DESK_BOTTOM)
    draw_rect(draw,
              0, dy1,
              W, dy2,
              fill=DESK_COLOR, outline=DESK_EDGE_COLOR, width=OUTLINE_W)

    # 桌面厚度边缘线（下方一条稍深的线）
    draw.line([(0, dy2), (W, dy2)], fill=DESK_EDGE_COLOR, width=OUTLINE_W)

    # 5. 桌面下方 = 墙色（已经是 WALL_COLOR）

    # 6. 桌面小摆件
    # 盆栽（左上角）——画大一点，绿色叶子 + 棕色花盆
    pot_cx = int(W * 0.10)
    pot_top = dy1 + 6
    pot_w = int(W * 0.08)
    pot_h = int(H * 0.035)
    # 花盆（梯形感：上面窄下面宽）
    pot_left = pot_cx - pot_w // 2
    pot_right = pot_cx + pot_w // 2
    pot_bottom = pot_top + pot_h
    draw_rect(draw,
              pot_left + 4, pot_top,
              pot_right - 4, pot_bottom,
              fill=(200, 150, 100), outline=OUTLINE_COLOR, width=OUTLINE_W)
    draw.rectangle([pot_left, pot_bottom - 8, pot_right, pot_bottom + 6],
                   fill=(180, 130, 80), outline=OUTLINE_COLOR, width=OUTLINE_W)
    # 叶子（3 个椭圆形叠在花盆上方）
    leaf_colors = [(90, 140, 60), (110, 160, 70), (80, 130, 50)]
    for i, (lx, ly, lw, lh, c) in enumerate([
        (pot_cx - 20, pot_top - 30, 24, 40, leaf_colors[0]),
        (pot_cx, pot_top - 45, 28, 50, leaf_colors[1]),
        (pot_cx + 18, pot_top - 25, 22, 38, leaf_colors[2]),
    ]):
        draw.ellipse([lx - lw//2, ly - lh//2, lx + lw//2, ly + lh//2],
                     fill=c, outline=OUTLINE_COLOR, width=OUTLINE_W)

    # 马克杯（右上角）——白色杯子 + 把手
    mug_cx = int(W * 0.88)
    mug_top = dy1 + 8
    mug_w = int(W * 0.06)
    mug_h = int(H * 0.04)
    mug_left = mug_cx - mug_w // 2
    mug_right = mug_cx + mug_w // 2
    mug_bottom = mug_top + mug_h
    # 杯身
    draw_rect(draw,
              mug_left, mug_top,
              mug_right, mug_bottom,
              fill=(240, 240, 240), outline=OUTLINE_COLOR, width=OUTLINE_W)
    # 杯口（深色咖啡）
    draw.ellipse([mug_left + 2, mug_top - 4, mug_right - 2, mug_top + 8],
                 fill=(90, 60, 40), outline=OUTLINE_COLOR, width=2)
    # 把手（右侧）
    handle_outer = [mug_right, mug_top + 8, mug_right + 12, mug_bottom - 4]
    draw.arc(handle_outer, 270, 90, fill=OUTLINE_COLOR, width=OUTLINE_W)
    draw.arc([mug_right + 3, mug_top + 11, mug_right + 9, mug_bottom - 7],
             270, 90, fill=OUTLINE_COLOR, width=OUTLINE_W)

    # 保存
    out_path = 'assets/resources/art/bg/bg-office.png'
    img.save(out_path)
    print(f'Generated: {out_path} ({W}x{H})')
    print(f'Screen: y={SCREEN_TOP*100:.0f}%-{SCREEN_BOTTOM*100:.0f}%  Desk: y={DESK_TOP*100:.0f}%  Gap: {(DESK_TOP-SCREEN_BOTTOM)*100:.0f}%')


if __name__ == '__main__':
    main()
