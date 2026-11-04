"""
把 AI 生成的鲸鱼图做成扩展图标。

    python chrome-extension/tools/make-icons-from-png.py <源图> [输出目录]

做三件事：
1. 去白底：从四角泛洪填充，把外部白色变透明。肚皮是近白色但被蓝色包围，
   泛洪到不了里面，所以不会被误伤。
2. 裁到内容外接框并补成正方形，四周留出固定比例的留白。
3. 合成到浅蓝圆角底板上，导出 16/32/48/128。
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PLATE_TOP = (237, 241, 255)
PLATE_BOTTOM = (215, 224, 255)
PADDING_RATIO = 0.05   # 鲸鱼四周留白占画布比例
CORNER_TOLERANCE = 26  # 判定「背景白」的容差


def flood_transparent(image: Image.Image, tolerance: int = CORNER_TOLERANCE) -> Image.Image:
    """从四角把连通的近白色刷成透明。"""
    rgba = np.array(image.convert("RGBA"))
    height, width = rgba.shape[:2]
    rgb = rgba[:, :, :3].astype(np.int16)

    # 与角落同色（近白）的像素视为背景候选
    seed = rgb[0, 0]
    near_seed = (np.abs(rgb - seed).max(axis=2) <= tolerance)

    # 从四边向内做 BFS 连通标记（只走 near_seed 的点）
    visited = np.zeros((height, width), dtype=bool)
    stack = []
    for x in range(width):
        for y in (0, height - 1):
            if near_seed[y, x]:
                stack.append((y, x))
    for y in range(height):
        for x in (0, width - 1):
            if near_seed[y, x]:
                stack.append((y, x))

    while stack:
        y, x = stack.pop()
        if y < 0 or x < 0 or y >= height or x >= width:
            continue
        if visited[y, x] or not near_seed[y, x]:
            continue
        visited[y, x] = True
        stack.extend(((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)))

    rgba[:, :, 3] = np.where(visited, 0, rgba[:, :, 3])
    return Image.fromarray(rgba, "RGBA")


def trim_square(image: Image.Image, padding_ratio: float = PADDING_RATIO) -> Image.Image:
    """裁到不透明区域，再补成正方形。"""
    alpha = np.array(image.split()[-1])
    ys, xs = np.where(alpha > 8)
    if len(xs) == 0:
        return image
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    content = image.crop(box)
    side = int(max(content.width, content.height) * (1 + padding_ratio * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(content, ((side - content.width) // 2, (side - content.height) // 2), content)
    return canvas


def plate(size: int) -> Image.Image:
    """浅蓝圆角底板。"""
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size))
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(int(PLATE_TOP[i] + (PLATE_BOTTOM[i] - PLATE_TOP[i]) * t) for i in range(3))
        ImageDraw.Draw(gradient).line([(0, y), (size, y)], fill=color + (255,))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    base.paste(gradient, (0, 0), mask)
    return base


def solid_plate(size: int) -> Image.Image:
    """纯品牌蓝底板（小尺寸用，保证对比度）。"""
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    fill = Image.new("RGBA", (size, size), (77, 107, 254, 255))
    base.paste(fill, (0, 0), mask)
    return base


def compose(master: Image.Image, size: int) -> Image.Image:
    """底板 + 居中鲸鱼。"""
    canvas = plate(size)
    inner = int(size * (1 - 2 * PADDING_RATIO))
    whale = master.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(whale, (offset, offset), whale)
    return canvas


def compose_small(master: Image.Image, size: int) -> Image.Image:
    """
    小尺寸专用：把鲸鱼压成单色剪影。

    16px 下细节必然丢失，硬缩只会得到一团糊。这里取 alpha 当遮罩、略微加粗，
    再填白色贴纯蓝底 —— 对比度高、轮廓清楚，牺牲的都是本来也看不见的细节。
    """
    inner = int(size * (1 - 2 * PADDING_RATIO * 0.6))
    scaled = master.resize((inner, inner), Image.LANCZOS)
    alpha = scaled.split()[-1]

    # 轻微膨胀，补回缩放时被吃掉的细笔画（尾巴、鳍）
    alpha = alpha.filter(ImageFilter.MaxFilter(3 if size <= 16 else 5))

    silhouette = Image.new("RGBA", (inner, inner), (255, 255, 255, 0))
    silhouette.putalpha(alpha)

    canvas = solid_plate(size)
    offset = (size - inner) // 2
    canvas.paste(silhouette, (offset, offset), silhouette)
    return canvas


def compose_bare(master: Image.Image, size: int, fill_ratio: float = 0.96) -> Image.Image:
    """
    不铺底板，鲸鱼直接放透明画布上。

    16px 下底板反而吃掉对比和空间：浅底+蓝鲸太糊，纯蓝底+白剪影又把细节挤没。
    官方 favicon 也是裸字形，靠浏览器/工具栏自身的底色提供对比。
    """
    inner = max(1, int(size * fill_ratio))
    whale = master.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - inner) // 2
    canvas.paste(whale, (offset, offset), whale)
    return canvas


def main() -> None:
    """
    用法:
        python make-icons-from-png.py <细节版源图> [输出目录] [--small 简化版源图]

    32/48/128 用细节版；16px 用简化版（单独的、为小尺寸画的图）。
    没有简化版时，16px 由细节版压成单色剪影。
    """
    save_masters = '--save-masters' in sys.argv
    args = [a for a in sys.argv[1:] if a not in ('--small', '--save-masters')]
    small_source = None
    if '--small' in sys.argv:
        index = sys.argv.index('--small')
        if index + 1 < len(sys.argv):
            small_source = Path(sys.argv[index + 1])
            args = [a for a in args if a != sys.argv[index + 1]]

    if not args:
        print("用法: python make-icons-from-png.py <源图> [输出目录] [--small <小尺寸源图>]")
        raise SystemExit(2)

    source = Path(args[0])
    out_dir = Path(args[1]) if len(args) > 1 else Path(__file__).resolve().parent.parent / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)

    raw = Image.open(source)
    cut = trim_square(flood_transparent(raw))

    # 留一份透明底的大图，方便以后复用 / 换底板
    if save_masters:
        cut.save(out_dir / "whale.png")
        print(f"  透明底主图 -> {out_dir / 'whale.png'} ({cut.width}x{cut.height})")

    small_cut = None
    if small_source and small_source.exists():
        small_cut = trim_square(flood_transparent(Image.open(small_source)))
        if save_masters:
            small_cut.save(out_dir / "whale-small.png")
            print(f"  小尺寸主图 -> {out_dir / 'whale-small.png'} ({small_cut.width}x{small_cut.height})")

    for size in (16, 32, 48, 128):
        if size <= 16:
            # 小尺寸不铺底板：裸字形 + 工具栏自身底色，对比反而最好
            icon = compose_bare(small_cut or cut, size)
        else:
            icon = compose(cut, size)
        icon.save(out_dir / f"icon{size}.png")
        print(f"  icon{size}.png")


if __name__ == "__main__":
    main()
