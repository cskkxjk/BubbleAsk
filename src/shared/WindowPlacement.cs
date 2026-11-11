using System;
using System.Drawing;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>
    /// 窗口摆放的共用规则。
    ///
    /// 网页版小窗和 API 气泡用**同一个尺寸、同一个位置**：位置存在
    /// `AppConfig.WindowX/WindowY` 里（-1 表示还没定），拖过之后记住，
    /// 下次从同一个地方出来，不再跟着鼠标跑。
    /// </summary>
    public static class WindowPlacement
    {
        /// <summary>窗口与屏幕边缘的最小间隙。</summary>
        public const int Margin = 12;

        /// <summary>这台机器上还没定过位置：默认放在主屏工作区右侧、垂直居中。</summary>
        public static Point Default(Size size)
        {
            Rectangle area = Screen.PrimaryScreen != null
                ? Screen.PrimaryScreen.WorkingArea
                : Screen.FromPoint(Cursor.Position).WorkingArea;
            int x = area.Right - size.Width - Margin;
            int y = area.Top + Math.Max(Margin, (area.Height - size.Height) / 2);
            return Fit(area, size, new Point(x, y));
        }

        /// <summary>把窗口夹进工作区，别让它一半在屏幕外。</summary>
        public static Point Fit(Rectangle area, Size size, Point prefer)
        {
            int maxX = Math.Max(area.Left + Margin, area.Right - size.Width - Margin);
            int maxY = Math.Max(area.Top + Margin, area.Bottom - size.Height - Margin);
            int x = Math.Min(Math.Max(prefer.X, area.Left + Margin), maxX);
            int y = Math.Min(Math.Max(prefer.Y, area.Top + Margin), maxY);
            return new Point(x, y);
        }

        /// <summary>按保存的位置放窗口；没保存过（或屏幕变了放不下）就回到默认位置。</summary>
        public static Point Resolve(AppConfig config, Size size)
        {
            if (config != null && config.WindowX >= 0 && config.WindowY >= 0)
            {
                Point saved = new Point(config.WindowX, config.WindowY);
                // 显示器拔掉/分辨率变了：保存的点不在任何屏幕上，回到默认位置
                Rectangle area = Screen.FromPoint(saved).WorkingArea;
                if (area.Contains(saved))
                {
                    return Fit(area, size, saved);
                }
            }
            return Default(size);
        }
    }
}
