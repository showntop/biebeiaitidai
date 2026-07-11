"""
只把桌子向下延伸（深度加高），显示器和桌面上沿位置不动。
- 桌子表面顶部 y=1208 不动
- 前面深色面板 (y=1397~1434) 向下延伸 ~360px 到 y=1794
- 加一条深色下边线 (y=1794~1800) 模拟桌沿
"""
from PIL import Image

SRC = "assets/resources/art/bg/bg-office.png"


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    pixels = im.load()
    w, h = im.size

    # 桌子表面颜色与前面颜色（取 x=500 实测）
    surface = (209, 177, 142)  # 桌面上沿
    surface_edge = (214, 184, 155)  # 桌面前沿
    front = (178, 139, 102)  # 桌子前脸
    front_edge = (180, 149, 124)  # 桌前下边线
    outline = (40, 35, 30)  # 黑色描边

    desk_top = 1208
    front_top = 1397
    old_front_bottom = 1435
    extend = 360  # 向下延伸 360px
    new_front_bottom = old_front_bottom + extend
    front_bottom_outline = new_front_bottom + 6  # 下边线

    # 1. 把原本透明区域 (y=1440 之后) 填充为前脸色，只在原来就是 desk 颜色带的列上
    for y in range(old_front_bottom, new_front_bottom):
        # 模拟原始 desk 的渐变（顶部略深，底部略浅）
        t = (y - old_front_bottom) / extend
        # 渐变：上深下浅一点点
        r = int(front[0] * (1 - t * 0.05))
        g = int(front[1] * (1 - t * 0.05))
        b = int(front[2] * (1 - t * 0.05))
        for x in range(w):
            pr, pg, pb, pa = pixels[x, y]
            if pa < 50:  # 原透明 → 填桌前色
                pixels[x, y] = (r, g, b, 255)
            elif pa > 200 and 100 < pr < 200 and 100 < pg < 160 and 90 < pb < 130:
                # 原前脸色，已是 desktop front
                pass

    # 2. 画下边线（黑色描边）
    for y in range(new_front_bottom, front_bottom_outline):
        for x in range(w):
            pr, pg, pb, pa = pixels[x, y]
            if pa > 200:
                # 已经是 desk front 或 surface，深一档
                pixels[x, y] = (
                    max(0, pr - 80),
                    max(0, pg - 80),
                    max(0, pb - 80),
                    255,
                )

    # 3. 在桌面表面前沿和前脸顶部之间，保留原来的黑色分界线
    for y in range(1391, 1397):
        for x in range(w):
            pr, pg, pb, pa = pixels[x, y]
            if pa > 200 and pr < 30 and pg < 30 and pb < 30:
                # 保持黑色分界线
                pixels[x, y] = (0, 0, 0, 255)

    im.save(SRC, "PNG", optimize=True)
    print(f"desk extended: front face {old_front_bottom}->{new_front_bottom} (+{extend}px), bottom edge at y={front_bottom_outline}")


if __name__ == "__main__":
    main()
