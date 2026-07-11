"""
把原图 bg-office.png 重新生成为 1:1 恢复版，只加宽桌子：
- 画布宽度从 1088 扩到 1400，高度 1920 不变
- 显示器居中保持不动
- 桌子 band (y=1288~1434) 向左右延伸到新画布边缘
- 桌子上面和下面的空白区域用墙面底色填充
"""
from PIL import Image

SRC = "assets/resources/art/bg/bg-office.png"
NEW_W = 1400  # 新画布宽度 +312px (+29%)
H = 1920

im = Image.open(SRC).convert("RGBA")
old_w = im.size[0]
px = im.load()

# 墙面底色（取原图墙面区域）
wall = (238, 226, 207)  # 米色墙

# 桌面主色（y=1300 x=500）
desk_surface = px[500, 1300][:3]  # ~(209, 177, 142)
# 桌前脸主色（y=1410 x=500）
desk_front = px[500, 1410][:3]  # ~(178, 139, 102)
# 黑色描边
outline = (30, 26, 22)

# 创建新画布，左右扩展，居中放原图
offset_x = (NEW_W - old_w) // 2
new_im = Image.new("RGBA", (NEW_W, H), (wall[0], wall[1], wall[2], 255))
new_px = new_im.load()

# 1. 先画墙面（已经通过 new_im 默认色完成）
# 2. 把原图贴到中间
for y in range(H):
    for x in range(old_w):
        r, g, b, a = px[x, y]
        if a > 0:
            new_px[offset_x + x, y] = (r, g, b, a)
        # 透明区域不留，保持墙色

# 3. 桌子表面带 (y=1288~1391) 向左右延伸
desk_surface_start = 1288
desk_surface_end = 1392
for y in range(desk_surface_start, desk_surface_end):
    # 取原图桌面该行的主色
    ref = px[500, y][:3]
    # 左延伸
    for x in range(0, offset_x):
        new_px[x, y] = (ref[0], ref[1], ref[2], 255)
    # 右延伸
    for x in range(offset_x + old_w, NEW_W):
        new_px[x, y] = (ref[0], ref[1], ref[2], 255)

# 4. 桌面前沿黑线 (y=1391~1397) 向左右延伸
for y in range(1391, 1397):
    for x in range(0, offset_x):
        new_px[x, y] = (0, 0, 0, 255)
    for x in range(offset_x + old_w, NEW_W):
        new_px[x, y] = (0, 0, 0, 255)

# 5. 桌子前脸 (y=1397~1435) 向左右延伸
for y in range(1397, 1435):
    ref = px[500, y][:3]
    for x in range(0, offset_x):
        new_px[x, y] = (ref[0], ref[1], ref[2], 255)
    for x in range(offset_x + old_w, NEW_W):
        new_px[x, y] = (ref[0], ref[1], ref[2], 255)

# 6. 桌子下边线 (y=1435~1440) 向左右延伸
for y in range(1435, 1440):
    for x in range(0, offset_x):
        new_px[x, y] = (outline[0], outline[1], outline[2], 255)
    for x in range(offset_x + old_w, NEW_W):
        new_px[x, y] = (outline[0], outline[1], outline[2], 255)

new_im.save(SRC, "PNG", optimize=True)
print(f"canvas: {old_w}→{NEW_W} (+{NEW_W-old_w}px, +{100*(NEW_W-old_w)//old_w}%),"
      f" desk surface band y={desk_surface_start}~{desk_surface_end},"
      f" front face y={1397}~1435, edge y=1435~1440")
