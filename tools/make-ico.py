"""
由鲸鱼母图生成 Windows 图标文件（assets/bubble-ask.ico）。

    python tools/make-ico.py

build.ps1 用 csc /win32icon 把它嵌进 exe，这样资源管理器 / 任务栏 / 快捷方式
显示的就是鲸鱼，而不是 .NET 的默认图标。

多尺寸是必须的：Windows 会按场景挑 16（任务栏小图标）、32（桌面）、48、256（大图标）。
只放一个尺寸会被放大得发糊。
"""
import importlib.util
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON_TOOL = ROOT / "chrome-extension" / "tools" / "make-icons-from-png.py"
ART = ROOT / "chrome-extension" / "tools" / "art"
OUT = ROOT / "assets" / "bubble-ask.ico"

spec = importlib.util.spec_from_file_location("icon_tool", ICON_TOOL)
icon_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icon_tool)

# Windows 常用的几档；256 用于资源管理器「大图标」视图
SIZES = (16, 24, 32, 48, 64, 128, 256)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    master = icon_tool.trim_square(icon_tool.flood_transparent(Image.open(ART / "whale.png")))
    small_master = icon_tool.trim_square(icon_tool.flood_transparent(Image.open(ART / "whale-small.png")))

    frames = []
    for size in SIZES:
        # 与扩展保持同一套规则：16px 用简化母图且不铺底板，其余用细节版 + 浅色底板
        image = icon_tool.compose_bare(small_master, size) if size <= 16 else icon_tool.compose(master, size)
        frames.append(image.convert("RGBA"))

    # 以最大帧保存，sizes= 一次性写入全部尺寸
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"  + assets/bubble-ask.ico  ({', '.join(str(s) for s in SIZES)})  {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
