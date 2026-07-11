"""
修复 bg-office.png：把桌子向上延伸，让 AI 同事角色坐在桌面上。
- 检测当前桌子带的 Y 范围与颜色
- 把桌子色带向上延伸 ~180px，并加一条暗色桌面前沿让过渡自然
- 保持透明 alpha 不变
"""
from PIL import Image
import sys

SRC = "assets/resources/art/bg/bg-office.png"
DST = "assets/resources/art/bg/bg-office.png"
EXTEND_PX = 180  # 向上延伸像素数


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    pixels = im.load()
    w, h = im.size
    # 找到桌子带的范围（采样 x = 200 远离中心避免命中显示器/桌面上的图标）
    sample_x = 200
    desk_top = None
    desk_bottom = None
    for y in range(h):
        r, g, b, a = pixels[sample_x, y]
        if a > 200 and 180 < r < 230 and 150 < g < 200 and 120 < b < 170:
            if desk_top is None:
                desk_top = y
            desk_bottom = y
    if desk_top is None:
        print("ERROR: cannot find desk band", file=sys.stderr)
        sys.exit(1)
    print(f"detected desk: y={desk_top}..{desk_bottom} "
          f"(h={desk_bottom - desk_top + 1}px)")

    # 桌子主色（取 desk_top+5 行 sample_x 列）
    main_r, main_g, main_b, _ = pixels[sample_x, desk_top + 5]
    print(f"desk main color: ({main_r}, {main_g}, {main_b})")

    # 桌子前沿色（更暗的桌沿）：取 desk_bottom 行（更深的棕）
    front_r, front_g, front_b, _ = pixels[sample_x, desk_bottom - 3]
    print(f"desk front color: ({front_r}, {front_g}, {front_b})")

    new_top = max(0, desk_top - EXTEND_PX)
    print(f"extending desk upward: {desk_top} -> {new_top} (+{desk_top - new_top}px)")

    # 逐行填色：从 new_top 到 desk_top-1
    # 用 desk_top+5 的主色填充；在 new_top..new_top+24 上用略深色作为桌面前沿阴影
    shadow_h = 26
    for y in range(new_top, desk_top):
        # 阴影区
        if y - new_top < shadow_h:
            t = (y - new_top) / shadow_h  # 0..1
            r = int(front_r * (1 - t) + main_r * t)
            g = int(front_g * (1 - t) + main_g * t)
            b = int(front_b * (1 - t) + main_b * t)
        else:
            # 上方主体用 main color，向 desk_top 略微变深模拟厚度
            depth = (y - (new_top + shadow_h)) / max(1, desk_top - (new_top + shadow_h))
            r = int(main_r * (1 - depth * 0.04))
            g = int(main_g * (1 - depth * 0.04))
            b = int(main_b * (1 - depth * 0.04))
        # 只填充原来是透明的区域（保留显示器/其他元素）
        for x in range(w):
            pr, pg, pb, pa = pixels[x, y]
            if pa < 50:  # 原透明 → 填桌子色
                pixels[x, y] = (r, g, b, 255)
            elif pa > 200 and 50 < pr < 90 and 50 < pg < 90 and 50 < pb < 95:
                # 原来就是显示器边框灰色 → 不动
                pass

    im.save(DST, "PNG", optimize=True)
    print(f"saved {DST} ({w}x{h})")


if __name__ == "__main__":
    main()
