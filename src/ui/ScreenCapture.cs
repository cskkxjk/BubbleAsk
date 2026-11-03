using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>全屏遮罩拖框截图，返回临时 PNG 路径。</summary>
    public static class ScreenCapture
    {
        private static bool _busy;

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        public static string CaptureInteractive()
        {
            if (_busy)
            {
                return null;
            }
            _busy = true;
            try
            {
                return CaptureCore();
            }
            finally
            {
                _busy = false;
            }
        }

        private static string CaptureCore()
        {
            Rectangle region;
            using (CaptureForm form = new CaptureForm())
            {
                if (form.ShowDialog() != DialogResult.OK)
                {
                    return null;
                }
                region = form.SelectedRegion;
            }

            if (region.Width < 8 || region.Height < 8)
            {
                return null;
            }

            // 等遮罩真正消失再截，否则会把遮罩一起截进去。
            Thread.Sleep(200);
            Application.DoEvents();

            try
            {
                using (Bitmap bitmap = new Bitmap(region.Width, region.Height))
                {
                    using (Graphics graphics = Graphics.FromImage(bitmap))
                    {
                        graphics.CopyFromScreen(region.Location, Point.Empty, region.Size);
                    }
                    string dir = Path.Combine(Path.GetTempPath(), "BubbleAsk");
                    Directory.CreateDirectory(dir);
                    string path = Path.Combine(dir, "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png");
                    bitmap.Save(path, ImageFormat.Png);
                    Log.Info("截图已保存: " + path + " (" + region.Width + "x" + region.Height + ")");
                    return path;
                }
            }
            catch (Exception error)
            {
                Log.Error("截图失败", error);
                return null;
            }
        }

        /// <summary>把上次留下的临时截图清掉，避免越攒越多。</summary>
        public static void CleanupOld(int days)
        {
            try
            {
                string dir = Path.Combine(Path.GetTempPath(), "BubbleAsk");
                if (!Directory.Exists(dir))
                {
                    return;
                }
                DateTime cutoff = DateTime.Now.AddDays(-Math.Max(1, days));
                string[] files = Directory.GetFiles(dir, "shot-*.png");
                int removed = 0;
                for (int i = 0; i < files.Length; i++)
                {
                    try
                    {
                        if (File.GetLastWriteTime(files[i]) < cutoff)
                        {
                            File.Delete(files[i]);
                            removed++;
                        }
                    }
                    catch
                    {
                    }
                }
                if (removed > 0)
                {
                    Log.Info("清理了 " + removed + " 张过期截图");
                }
            }
            catch (Exception error)
            {
                Log.Warn("清理临时截图失败: " + error.Message);
            }
        }

        private class CaptureForm : Form
        {
            private const int WmHotkey = 0x0312;
            private const int EscapeHotkeyId = 0x5A5A;
            private const uint VkEscape = 0x1B;

            private Point _origin;
            private bool _dragging;
            private bool _escapeRegistered;
            private Rectangle _region = Rectangle.Empty;

            [DllImport("user32.dll", SetLastError = true)]
            private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);

            [DllImport("user32.dll", SetLastError = true)]
            private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

            public Rectangle SelectedRegion
            {
                get { return _region; }
            }

            public CaptureForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.Manual;
                Bounds = SystemInformation.VirtualScreen;
                TopMost = true;
                ShowInTaskbar = false;
                BackColor = Color.Black;
                Opacity = 0.3;
                DoubleBuffered = true;
                Cursor = Cursors.Cross;
                KeyPreview = true;
            }

            protected override void OnShown(EventArgs e)
            {
                base.OnShown(e);
                // 托盘程序是后台进程，ShowDialog 拿不到前台权限，键盘事件就收不到；
                // 先把当前前台线程的输入挂到自己身上，再抢一次前台。
                StealForeground();

                // 焦点可能确实抢不到，那就把 Esc 注册成全局热键，跟焦点无关。
                _escapeRegistered = RegisterHotKey(Handle, EscapeHotkeyId, 0, VkEscape);
                if (!_escapeRegistered)
                {
                    Log.Warn("Esc 热键注册失败，遮罩仍可用鼠标取消");
                }
            }

            protected override void OnFormClosed(FormClosedEventArgs e)
            {
                if (_escapeRegistered)
                {
                    try
                    {
                        UnregisterHotKey(Handle, EscapeHotkeyId);
                    }
                    catch
                    {
                    }
                    _escapeRegistered = false;
                }
                base.OnFormClosed(e);
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WmHotkey && m.WParam.ToInt32() == EscapeHotkeyId)
                {
                    // 在消息处理里直接关窗容易出问题，丢回消息队列再关。
                    BeginInvoke(new MethodInvoker(delegate
                    {
                        DialogResult = DialogResult.Cancel;
                        Close();
                    }));
                    return;
                }
                base.WndProc(ref m);
            }

            private void StealForeground()
            {
                IntPtr foreground = GetForegroundWindow();
                uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
                uint currentThread = GetCurrentThreadId();
                bool attached = false;
                try
                {
                    if (foregroundThread != 0 && foregroundThread != currentThread)
                    {
                        attached = AttachThreadInput(currentThread, foregroundThread, true);
                    }
                    BringWindowToTop(Handle);
                    SetForegroundWindow(Handle);
                    Activate();
                    Focus();
                }
                catch (Exception error)
                {
                    Log.Warn("遮罩抢前台失败: " + error.Message);
                }
                finally
                {
                    if (attached)
                    {
                        AttachThreadInput(currentThread, foregroundThread, false);
                    }
                }
            }

            protected override void OnMouseDown(MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Right)
                {
                    DialogResult = DialogResult.Cancel;
                    Close();
                    return;
                }
                if (e.Button == MouseButtons.Left)
                {
                    _dragging = true;
                    _origin = e.Location;
                    _region = new Rectangle(e.Location, Size.Empty);
                    Invalidate();
                }
                base.OnMouseDown(e);
            }

            protected override void OnMouseMove(MouseEventArgs e)
            {
                if (_dragging)
                {
                    _region = Normalize(_origin, e.Location);
                    Invalidate();
                }
                base.OnMouseMove(e);
            }

            protected override void OnMouseUp(MouseEventArgs e)
            {
                if (_dragging && e.Button == MouseButtons.Left)
                {
                    _dragging = false;
                    _region = Normalize(_origin, e.Location);
                    if (_region.Width >= 8 && _region.Height >= 8)
                    {
                        DialogResult = DialogResult.OK;
                        Close();
                        return;
                    }
                    // 只是点了一下没框选：当成取消，不然遮罩会一直挂着。
                    DialogResult = DialogResult.Cancel;
                    Close();
                    return;
                }
                base.OnMouseUp(e);
            }

            protected override void OnKeyDown(KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape)
                {
                    DialogResult = DialogResult.Cancel;
                    Close();
                }
                base.OnKeyDown(e);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                if (_region.Width <= 0 || _region.Height <= 0)
                {
                    TextRenderer.DrawText(e.Graphics, "拖动鼠标框选区域；单击或右键取消，Esc 也可以", SystemFonts.DefaultFont,
                        new Point(24, 24), Color.White);
                    return;
                }

                using (Pen border = new Pen(Color.FromArgb(77, 107, 254), 2))
                {
                    e.Graphics.DrawRectangle(border, _region);
                }

                Rectangle label = new Rectangle(_region.X, Math.Max(0, _region.Y - 24), 140, 22);
                using (SolidBrush brush = new SolidBrush(Color.FromArgb(180, 0, 0, 0)))
                {
                    e.Graphics.FillRectangle(brush, label);
                }
                TextRenderer.DrawText(e.Graphics, _region.Width + " × " + _region.Height,
                    SystemFonts.DefaultFont, new Point(label.X + 6, label.Y + 4), Color.White);
            }

            private static Rectangle Normalize(Point a, Point b)
            {
                int x = Math.Min(a.X, b.X);
                int y = Math.Min(a.Y, b.Y);
                return new Rectangle(x, y, Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
            }
        }
    }
}
