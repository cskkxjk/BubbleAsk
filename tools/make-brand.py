"""
生成 README / 文档用的品牌图（assets/）。

    python tools/make-brand.py

产物：
    assets/brand-256.png    README 页头 logo（256×256，与扩展图标同一套视觉）
    assets/brand-sizes.png  各尺寸一览（浅色/深色两行 + 大图），用于检查小尺寸是否可辨

母图与合成逻辑都复用 chrome-extension/tools/make-icons-from-png.py，避免两套画法又漂移。
这两个文件以前是手工做的、没有生成脚本，换图标时忘了同步 —— 现在可一键重出。
"""
import importlib.util
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_TOOL = ROOT / "chrome-extension" / "tools" / "make-icons-from-png.py"
ART = ROOT / "chrome-extension" / "tools" / "art"
OUT = ROOT / "assets"

# 复用图标脚本里的去背/裁切/底板/合成
spec = importlib.util.spec_from_file_location("icon_tool", ICON_TOOL)
icon_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icon_tool)

# 用浏览器工具栏的浅灰而不是纯白：16px 是「裸鲸鱼无底板」，纯白上看不见，灰底才接近真实使用场景
LIGHT_BG = (242, 242, 242)
DARK_BG = (31, 31, 31)
GAP = 16
PAD = 16
SIZES = (16, 32, 48)
# README 页头 logo 的尺寸（文件名就叫 brand-256，别跟着一览图变）
BRAND_SIZE = 256
# 一览图右侧的大图。用 128 而不是 256：这张图是「小尺寸是否可辨」的检查表，
# 不是展示图，横条比竖块好用（原来的手工版也是横条）。
HERO = 128


def load_master(path: Path) -> Image.Image:
    return icon_tool.trim_square(icon_tool.flood_transparent(Image.open(path)))


def build_brand_256(master: Image.Image) -> Image.Image:
    """README 页头：和扩展图标同一套构图，只是尺寸更大。"""
    return icon_tool.compose(master, BRAND_SIZE)


def build_sizes_sheet(master: Image.Image) -> Image.Image:
    """
    各尺寸一览：浅色行、深色行，右侧放 256 大图。

    小尺寸用它自己的母图（线条更粗），大尺寸用细节版 —— 与扩展实际打包一致，
    这样这张图能真实反映「用户在工具栏里看到什么」。
    """
    small_master = load_master(ART / "whale-small.png")

    def icon(size: int) -> Image.Image:
        # 16px 走简化母图 + 不铺底板（与 make-icons-from-png.py 的规则一致）
        if size <= 16:
            return icon_tool.compose_bare(small_master, size)
        return icon_tool.compose(master, size)

    row_icons = [icon(size) for size in SIZES]
    hero = icon_tool.compose(master, HERO)

    row_h = max(HERO, max(i.height for i in row_icons))
    row_w = sum(i.width for i in row_icons) + GAP * (len(row_icons) - 1)
    width = PAD + row_w + GAP * 2 + HERO + PAD
    height = PAD + row_h + GAP + row_h + PAD

    sheet = Image.new("RGBA", (width, height), LIGHT_BG + (255,))
    draw = ImageDraw.Draw(sheet)
    # 下半区深色，检查深色背景下是否可辨
    draw.rectangle([0, PAD + row_h + GAP, width, height], fill=DARK_BG + (255,))

    for row, top in enumerate((PAD, PAD + row_h + GAP)):
        x = PAD
        for item in row_icons:
            y = top + (row_h - item.height) // 2
            sheet.paste(item, (x, y), item)
            x += item.width + GAP
        sheet.paste(hero, (PAD + row_w + GAP * 2, top + (row_h - hero.height) // 2), hero)

    return sheet


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = load_master(ART / "whale.png")

    brand = build_brand_256(master)
    brand.save(OUT / "brand-256.png")
    print(f"  + assets/brand-256.png  ({brand.width}x{brand.height})")

    sheet = build_sizes_sheet(master)
    sheet.save(OUT / "brand-sizes.png")
    print(f"  + assets/brand-sizes.png  ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    main()
