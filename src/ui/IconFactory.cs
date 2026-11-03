using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;

namespace BubbleAsk
{
    /// <summary>
    /// 运行时画品牌图标：蓝色圆角底 + 白色对话气泡 + 问号。
    /// 小尺寸（托盘 16px）自动省略问号，只留气泡轮廓，避免糊成一团。
    /// </summary>
    public static class IconFactory
    {
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        public static Icon Create(int size)
        {
            using (Bitmap bitmap = new Bitmap(size, size))
            {
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    g.Clear(Color.Transparent);

                    Rectangle body = new Rectangle(0, 0, size - 1, size - 1);
                    using (GraphicsPath background = RoundedRect(body, (float)(size * 0.23)))
                    using (LinearGradientBrush brush = new LinearGradientBrush(
                        body, Color.FromArgb(112, 141, 255), Color.FromArgb(58, 87, 235), 60f))
                    {
                        g.FillPath(brush, background);
                    }

                    float bubbleX = size * 0.20f;
                    float bubbleY = size * 0.21f;
                    float bubbleW = size * 0.60f;
                    float bubbleH = size * 0.43f;
                    float radius = Math.Max(2f, size * 0.11f);

                    using (GraphicsPath bubble = RoundedRect(
                        new RectangleF(bubbleX, bubbleY, bubbleW, bubbleH), radius))
                    using (SolidBrush white = new SolidBrush(Color.White))
                    {
                        g.FillPath(white, bubble);

                        // 左下角的小尾巴，让它一眼是“对话气泡”。
                        PointF[] tail = new PointF[]
                        {
                            new PointF(bubbleX + bubbleW * 0.20f, bubbleY + bubbleH * 0.82f),
                            new PointF(bubbleX + bubbleW * 0.30f, bubbleY + bubbleH + size * 0.15f),
                            new PointF(bubbleX + bubbleW * 0.50f, bubbleY + bubbleH * 0.92f)
                        };
                        g.FillPolygon(white, tail);
                    }

                    // 小图标放不下问号，宁可干净。
                    if (size >= 24)
                    {
                        using (Font font = new Font("Microsoft YaHei", size * 0.30f, FontStyle.Bold, GraphicsUnit.Pixel))
                        using (SolidBrush ink = new SolidBrush(Color.FromArgb(52, 78, 220)))
                        using (StringFormat format = new StringFormat())
                        {
                            format.Alignment = StringAlignment.Center;
                            format.LineAlignment = StringAlignment.Center;
                            RectangleF textRect = new RectangleF(bubbleX, bubbleY - size * 0.02f, bubbleW, bubbleH);
                            g.DrawString("?", font, ink, textRect, format);
                        }
                    }
                }

                IntPtr handle = bitmap.GetHicon();
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

        private static GraphicsPath RoundedRect(Rectangle bounds, float radius)
        {
            return RoundedRect(new RectangleF(bounds.X, bounds.Y, bounds.Width, bounds.Height), radius);
        }

        private static GraphicsPath RoundedRect(RectangleF bounds, float radius)
        {
            float diameter = radius * 2f;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
