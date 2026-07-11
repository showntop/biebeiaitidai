#!/bin/bash
# 从 Lucide CDN 下载 SVG 图标 → 转纯图标 PNG (256×256, 单色 #333)
# 用法: bash scripts/download-icons.sh
set -e

BASE="https://cdn.jsdelivr.net/npm/lucide-static@latest/icons"
TMP="/tmp/lucide-icons"
ICON_COLOR="#333333"
STROKE_W="2.5"

rm -rf "$TMP"
mkdir -p "$TMP"

# ============== 图标列表（文件名 icon-name 对，空格分隔） ==============
ICONS="
card-doc-blue-a file-text
card-doc-blue-b file
card-doc-stack files
card-target target
card-idea lightbulb
card-alarm alarm-clock
card-coffee coffee
card-boss-audit search
card-boss search
card-routine file-text
card-document file

prop-add-demand file-plus
prop-change-demand refresh-cw
prop-throw-pot cooking-pot
prop-kiss-up heart

icon-event-log clipboard-list
"

echo "=== 下载 Lucide SVG ==="
count=0
while read -r filename icon; do
  [ -z "$filename" ] && continue
  url="${BASE}/${icon}.svg"
  out="${TMP}/${filename}.svg"
  echo "  ${filename} ← lucide:${icon}"
  if curl -sL --connect-timeout 5 "$url" -o "$out"; then
    count=$((count + 1))
    # 修正颜色 + 加粗描边
    sed -i '' "s/currentColor/${ICON_COLOR}/g" "$out"
    sed -i '' "s/stroke-width=\"2\"/stroke-width=\"${STROKE_W}\"/g" "$out"
  else
    echo "  ⚠️ 下载失败: ${icon}"
  fi
done <<< "$ICONS"

echo ""
echo "=== SVG → PNG (256×256) ==="
for svg in "$TMP"/*.svg; do
  name=$(basename "$svg" .svg)
  rsvg-convert -w 256 -h 256 "$svg" -o "${TMP}/${name}.png" 2>/dev/null && echo "  ✓ ${name}.png" || echo "  ✗ ${name}.png 失败"
done

# Boss 卡是黑底金边，dark gray 图标会消失，重新生成白色版本
if [ -f "$TMP/card-boss-audit.svg" ]; then
  sed -i '' 's/currentColor/#FFFFFF/g' "$TMP/card-boss-audit.svg"
  rsvg-convert -w 256 -h 256 "$TMP/card-boss-audit.svg" -o "$TMP/card-boss-audit.png" 2>/dev/null
  echo "  ✓ card-boss-audit.png → 白色 (适配 boss 黑底)"
fi

echo ""
echo "=== 复制到 assets/resources/art/ ==="
for png in "$TMP"/card-*.png; do
  [ -f "$png" ] || continue
  name=$(basename "$png")
  cp "$png" "assets/resources/art/cards/${name}"
  echo "  → cards/${name}"
done
for png in "$TMP"/prop-*.png; do
  [ -f "$png" ] || continue
  name=$(basename "$png")
  cp "$png" "assets/resources/art/props/${name}"
  echo "  → props/${name}"
done
if [ -f "$TMP/icon-event-log.png" ]; then
  cp "$TMP/icon-event-log.png" "assets/resources/art/cards/icon-event-log.png"
  echo "  → cards/icon-event-log.png"
fi

echo ""
echo "=== 完成: ${count} 个图标 ==="
echo "提示: 在 Cocos Creator 中刷新资源面板，更新 .meta 引用"
