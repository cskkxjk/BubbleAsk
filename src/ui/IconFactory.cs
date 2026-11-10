using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace BubbleAsk
{
    /// <summary>
    /// 托盘图标：取自内嵌的鲸鱼 PNG（`assets/brand-256.png` 的子集，见 build.ps1 的 /resource）。
    ///
    /// 以前这里是运行时用 GDI+ 画「蓝底 + 白气泡 + 问号」—— 那是初版品牌图，
    /// 扩展和插件早已换成小鲸鱼，桌面端却一直没跟上，托盘里还是旧图标。
    /// 现在与另外两个产物同源：都来自 `chrome-extension/tools/art/whale.png`。
    /// </summary>
    public static class IconFactory
    {
        /// <summary>内嵌资源名：build.ps1 里用 /resource:...,BubbleAsk.icon.png 指定。</summary>
        private const string ResourceName = "BubbleAsk.icon.png";

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        private static Bitmap _source;

        private static Bitmap Source()
        {
            if (_source == null)
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                using (Stream stream = assembly.GetManifestResourceStream(ResourceName))
                {
                    if (stream == null)
                    {
                        throw new InvalidOperationException(
                            "缺少内嵌资源 " + ResourceName + "（build.ps1 的 /resource 参数漏了图标？）");
                    }
                    // 复制到内存流再解码：清单资源流不可 seek 到底层，Bitmap 需要它
                    using (MemoryStream buffer = new MemoryStream())
                    {
                        stream.CopyTo(buffer);
                        buffer.Position = 0;
                        _source = new Bitmap(buffer);
                    }
                }
            }
            return _source;
        }

        /// <summary>生成指定边长的图标（托盘 16、菜单 20/24、窗口 32/48 都会用到）。</summary>
        public static Icon Create(int size)
        {
            int edge = size < 8 ? 8 : size;
            Bitmap source = Source();

            using (Bitmap canvas = new Bitmap(edge, edge, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(canvas))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.Clear(Color.Transparent);
                    g.DrawImage(source, new Rectangle(0, 0, edge, edge));
                }

                IntPtr handle = canvas.GetHicon();
                try
                {
                    using (Icon temporary = Icon.FromHandle(handle))
                    {
                        return (Icon)temporary.Clone();
                    }
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }
    }
}
