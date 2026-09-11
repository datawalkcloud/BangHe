#!/usr/bin/env python3
"""从品牌源图裁出「只要图标」的成品，覆盖 App 图标与前端 logo。

源图 brand/logo-source.png 是带透明通道的「图形 + 磅禾 + 收粮系统」组合稿。
本脚本按整行全透明把画面切成若干内容块，取**最上面那块**（盾形 + 两片叶子）作为图形，
下面两行文字商标全部丢弃，等比居中贴进方形透明画布：

  · src-tauri/icons/app-icon.png  1024x1024  —— `npx tauri icon` 的母图
  · public/logo.png                256x256   —— 浏览器 favicon + 侧栏 Brand

重跑：python scripts/make-app-icon.py
母图换完记得再跑 `npx tauri icon src-tauri/icons/app-icon.png` 生成 ico/icns/磁贴全套。
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

if hasattr(sys.stdout, "reconfigure"):  # Windows 控制台默认 GBK，中文输出会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "brand" / "logo-source.png"
OUT_TAURI = ROOT / "src-tauri" / "icons" / "app-icon.png"
OUT_WEB = ROOT / "public" / "logo.png"

MASTER_PX = 1024  # tauri 母图边长
WEB_PX = 256  # favicon / 界面用
MARGIN = 0.06  # 方形画布四周留白比例（图形占 88%）
ALPHA_FLOOR = 8  # 低于此 alpha 视为透明（源图边缘有半像素羽化）
MIN_GAP_ROWS = 12  # 连续这么多整行透明才算一道分隔带


def empty_runs(alpha: Image.Image) -> list[tuple[int, int]]:
    """返回所有「整行都透明」的连续行区间 [start, end]（含端点）。"""
    w, h = alpha.size
    runs: list[tuple[int, int]] = []
    start = None
    for y in range(h):
        if alpha.crop((0, y, w, y + 1)).getbbox() is None:
            if start is None:
                start = y
        elif start is not None:
            runs.append((start, y - 1))
            start = None
    if start is not None:
        runs.append((start, h - 1))
    return runs


def mark_bbox(img: Image.Image) -> tuple[tuple[int, int, int, int], int]:
    """图形区 = 第一道内部空白带以上的内容；返回 (bbox, 分界行)。

    源图自上而下是三块：图形（盾+叶）/「磅禾」/「— 收粮系统 —」。图形与字标之间
    那道缝（约 25 行）比两行文字之间（约 35 行）窄，所以判据是「第一道空白带」，
    不是「最宽空白带」。
    """
    alpha = img.getchannel("A").point(lambda v: 255 if v > ALPHA_FLOOR else 0)
    w, h = img.size
    interior = [(s, e) for s, e in empty_runs(alpha) if s > 0 and e < h - 1 and e - s + 1 >= MIN_GAP_ROWS]
    if not interior:
        raise SystemExit("没找到图形与文字之间的空白带：源图里字和图形贴一起了，请人工裁图")
    split = interior[0][0]
    band = alpha.crop((0, 0, w, split))
    bbox = band.getbbox()
    if bbox is None:
        raise SystemExit("空白带以上没有内容，分界取错了")
    return bbox, split


def square_master(img: Image.Image, bbox: tuple[int, int, int, int], px: int) -> Image.Image:
    """裁出图形 → 等比缩放 → 居中贴到 px×px 透明画布 → 填掉封闭镂空。"""
    mark = img.crop(bbox)
    inner = round(px * (1 - 2 * MARGIN))
    scale = inner / max(mark.size)
    resized = mark.resize(
        (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
        Image.LANCZOS,
    )
    canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    canvas.paste(resized, ((px - resized.width) // 2, (px - resized.height) // 2), resized)
    return fill_enclosed_holes(canvas)


def fill_enclosed_holes(canvas: Image.Image, color: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """把「被图形包住的透明镂空」填成白色。

    源稿的麦穗、屋顶高光不是画上去的白，而是透明镂空：放在白底上看着正常，落到
    深色侧栏或深色桌面上就会透出背景、细节直接消失。做法是透明像素先染哨兵色，从
    左上角洪水填充标记与外界连通的真空透明区，剩下没被染到的哨兵色即封闭镂空。
    """
    sentinel = (254, 0, 254)
    outside_fill = (1, 2, 3)
    alpha_mask = canvas.getchannel("A").point(lambda v: 255 if v <= ALPHA_FLOOR else 0)
    probe = canvas.convert("RGB")
    probe.paste(Image.new("RGB", canvas.size, sentinel), (0, 0), alpha_mask)
    ImageDraw.floodfill(probe, (0, 0), outside_fill)
    holes = ImageChops.difference(probe, Image.new("RGB", canvas.size, sentinel)).convert("L")
    holes = holes.point(lambda v: 255 if v == 0 else 0)
    filled = canvas.copy()
    filled.paste(Image.new("RGBA", canvas.size, color + (255,)), (0, 0), holes)
    return filled


def main() -> None:
    img = Image.open(SOURCE).convert("RGBA")
    (x0, y0, x1, y1), split = mark_bbox(img)
    print(f"源图 {img.size[0]}x{img.size[1]}，分界行 y={split}，图形区 {x1 - x0}x{y1 - y0}，下方文字商标已丢弃")

    OUT_TAURI.parent.mkdir(parents=True, exist_ok=True)
    OUT_WEB.parent.mkdir(parents=True, exist_ok=True)
    square_master(img, (x0, y0, x1, y1), MASTER_PX).save(OUT_TAURI)
    square_master(img, (x0, y0, x1, y1), WEB_PX).save(OUT_WEB)
    print(f"写出 {OUT_TAURI.relative_to(ROOT).as_posix()} ({MASTER_PX}px)、{OUT_WEB.relative_to(ROOT).as_posix()} ({WEB_PX}px)")


if __name__ == "__main__":
    main()
