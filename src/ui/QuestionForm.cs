using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>
    /// 抓词提问前显示的问题输入卡片。
    ///
    /// 三种结果：
    ///   - 写了问题 → 问题与选中文字一起发出（PromptBuilder.BuildWithQuestion）；
    ///   - 直接回车（留空）→ 使用配置里的模板；
    ///   - Esc 或「取消」→ 不发送任何内容。
    ///
    /// 外观与网页端卡片一致：白底圆角、细边框，输入框做成浅蓝的圆角凹槽（鱼肚）。
    ///
    /// 摆放：尺寸与控件位置按 96 DPI 的设计值记录，显示前按窗口所在显示器的 DPI
    /// 等比换算。125% / 150% 缩放下文字随 DPI 变大，卡片跟着放大，内容不会溢出。
    /// 位置优先落在前台窗口所在显示器，光标停在不显示的那块屏时也不会跑过去。
    /// </summary>
    internal sealed class QuestionForm : Form
    {
        private static readonly Color Ink = Color.FromArgb(31, 41, 55);
        private static readonly Color Dim = Color.FromArgb(122, 131, 148);
        private static readonly Color Line = Color.FromArgb(226, 230, 239);
        private static readonly Color Belly = Color.FromArgb(239, 243, 255);
        private static readonly Color BellyLine = Color.FromArgb(214, 222, 252);
        private static readonly Color Accent = Color.FromArgb(77, 107, 254);

        /// <summary>96 DPI 下的卡片尺寸。</summary>
        private const int DesignWidth = 452;
        private const int DesignHeight = 208;

        private const int DesignCardRadius = 14;
        private const int DesignBellyRadius = 16;
        private const int DesignButtonRadius = 9;

        /// <summary>96 DPI 下的控件位置（与早先直接写死的像素值一致）。</summary>
        private static readonly Rectangle TitleRect = new Rectangle(96, 24, 340, 22);
        private static readonly Rectangle QuoteRect = new Rectangle(96, 49, 340, 20);
        private static readonly Rectangle BellyRect = new Rectangle(18, 86, 416, 48);
        private static readonly Rectangle InputRect = new Rectangle(34, 98, 384, 24);
        private static readonly Rectangle HintRect = new Rectangle(20, 142, 412, 18);
        private static readonly Rectangle CancelRect = new Rectangle(286, 168, 66, 30);
        private static readonly Rectangle SendRect = new Rectangle(360, 168, 74, 30);
        private static readonly Rectangle MascotRect = new Rectangle(18, 24, 64, 39);
        private static readonly Rectangle BadgeRect = new Rectangle(30, 8, 22, 22);

        /// <summary>鲸鱼略微透明，避免压住旁边的文字。</summary>
        private const float MascotOpacity = 0.9F;

        private readonly Label _title;
        private readonly Label _quote;
        private readonly Label _hint;
        private readonly TextBox _input;
        private readonly Button _cancel;
        private readonly Button _send;
        private readonly Font _titleFont;
        private readonly Font _smallFont;
        private readonly Font _badgeFont;
        private readonly Font _inputFont;
        private readonly Font _buttonFont;
        private readonly float _scaleOverride;

        private float _scale = 1F;
        private int _dpi;
        private string _question;

        private bool _dragging;
        private Point _dragStart;
        private Point _dragOrigin;

        internal QuestionForm(string selected, string template)
            : this(selected, template, 0F)
        {
        }

        /// <param name="scaleOverride">
        /// 自测用：强制缩放比例，0 表示按显示器 DPI 自动换算。
        /// </param>
        internal QuestionForm(string selected, string template, float scaleOverride)
        {
            string skeleton = ShortTemplate(template);
            _scaleOverride = scaleOverride;
            _titleFont = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold);
            _smallFont = new Font("Microsoft YaHei UI", 8.5F);
            _badgeFont = new Font("Segoe UI", 9F, FontStyle.Bold);
            _inputFont = new Font("Microsoft YaHei UI", 10F);
            _buttonFont = new Font("Microsoft YaHei UI", 9F);

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.White;
            Padding = new Padding(1);
            DoubleBuffered = true;
            KeyPreview = true;
            Text = "Bubble Ask · 抓词提问";
            // 尺寸自己按 DPI 换算，不让 WinForms 再缩一遍
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(DesignWidth, DesignHeight);

            _title = new Label();
            _title.AutoSize = false;
            _title.ForeColor = Ink;
            _title.Font = _titleFont;
            _title.Text = "你想问什么？";
            _title.MouseDown += DragStart;
            _title.MouseMove += DragMove;
            _title.MouseUp += DragEnd;
            Controls.Add(_title);

            _quote = new Label();
            _quote.AutoSize = false;
            _quote.ForeColor = Dim;
            _quote.Font = _smallFont;
            _quote.AutoEllipsis = true;
            _quote.Text = selected ?? string.Empty;
            _quote.MouseDown += DragStart;
            _quote.MouseMove += DragMove;
            _quote.MouseUp += DragEnd;
            Controls.Add(_quote);

            _input = new TextBox();
            _input.BorderStyle = BorderStyle.None;
            _input.BackColor = Belly;
            _input.ForeColor = Ink;
            _input.Font = _inputFont;
            Controls.Add(_input);

            _hint = new Label();
            _hint.AutoSize = false;
            _hint.ForeColor = Dim;
            _hint.Font = _smallFont;
            _hint.Text = "回车发送 · Esc 取消 · 留空则按模板「" + skeleton + "」提问";
            Controls.Add(_hint);

            _cancel = new Button();
            _cancel.Text = "取消";
            StyleButton(_cancel, false);
            _cancel.DialogResult = DialogResult.Cancel;
            Controls.Add(_cancel);
            CancelButton = _cancel;

            _send = new Button();
            _send.Text = "发送";
            StyleButton(_send, true);
            _send.Click += OnSend;
            Controls.Add(_send);
            AcceptButton = _send;

            MouseDown += DragStart;
            MouseMove += DragMove;
            MouseUp += DragEnd;

            ApplyScale(1F);
            // 先按设计尺寸粗放一次，避免窗口在 (0,0) 创建、被系统当成主屏 DPI；
            // 真正的尺寸与位置在 OnLoad 里按显示器 DPI 重算。
            PlaceCard();
        }

        /// <summary>提示里只放模板骨架，太长的模板会把这一行撑爆。</summary>
        private static string ShortTemplate(string template)
        {
            string value = string.IsNullOrEmpty(template) ? PromptBuilder.DefaultTemplate : template.Trim();
            return value.Length <= 16 ? value : value.Substring(0, 15) + "…";
        }

        /// <summary>扁平按钮：主按钮实心蓝，次按钮白底细边，都切圆角。</summary>
        private void StyleButton(Button button, bool primary)
        {
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = primary ? 0 : 1;
            button.FlatAppearance.BorderColor = Line;
            button.BackColor = primary ? Accent : Color.White;
            button.ForeColor = primary ? Color.White : Ink;
            button.Font = _buttonFont;
            button.Cursor = Cursors.Hand;
            button.UseVisualStyleBackColor = false;
            RoundButton(button);
        }

        /// <summary>按按钮当前尺寸重新切圆角（缩放变化后要重算）。</summary>
        private void RoundButton(Button button)
        {
            using (GraphicsPath path = Rounded(new Rectangle(0, 0, button.Width - 1, button.Height - 1), Px(DesignButtonRadius)))
            {
                Region old = button.Region;
                button.Region = new Region(path);
                if (old != null)
                {
                    old.Dispose();
                }
            }
        }

        private static GraphicsPath Rounded(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int diameter = Math.Max(2, radius);
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>96 DPI 的设计像素换算成当前缩放下的像素。</summary>
        private int Px(int value)
        {
            return (int)Math.Round(value * _scale);
        }

        private Rectangle Scale(Rectangle rect)
        {
            return new Rectangle(Px(rect.X), Px(rect.Y), Px(rect.Width), Px(rect.Height));
        }

        /// <summary>按缩放比例重排控件。字体用点数，DPI 变化时系统已经按比例放大，这里只换算位置。</summary>
        private void ApplyScale(float scale)
        {
            if (_scaleOverride > 0F)
            {
                scale = _scaleOverride;
            }
            if (scale < 0.5F)
            {
                scale = 1F;
            }
            _scale = scale;

            SuspendLayout();
            ClientSize = new Size(Px(DesignWidth), Px(DesignHeight));
            _title.Bounds = Scale(TitleRect);
            _quote.Bounds = Scale(QuoteRect);
            _hint.Bounds = Scale(HintRect);
            _cancel.Bounds = Scale(CancelRect);
            _send.Bounds = Scale(SendRect);

            // 单行输入框的高度由字体决定，只定左右，纵向在鱼肚里居中
            Rectangle belly = Scale(BellyRect);
            Rectangle input = Scale(InputRect);
            int top = belly.Y + Math.Max(0, (belly.Height - _input.Height) / 2);
            _input.SetBounds(input.X, top, input.Width, _input.Height);

            RoundButton(_cancel);
            RoundButton(_send);
            ResumeLayout(true);
            Invalidate();
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            _dpi = DeviceDpi;
            ApplyScale(_dpi / 96F);
            PlaceCard();
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            _dpi = e.DeviceDpiNew;
            ApplyScale(_dpi / 96F);
            PlaceCard();
        }

        /// <summary>
        /// 把卡片放到光标附近。
        ///
        /// 显示器用前台窗口所在的那块：光标可能停在一块没有输出的副屏上（线接着、
        /// 屏幕关着，Windows 仍把它算作可用显示器），按光标放就会落到看不见的地方。
        /// </summary>
        private void PlaceCard()
        {
            Point cursor = Cursor.Position;
            Screen screen = TargetScreen(cursor);
            Rectangle work = screen != null ? screen.WorkingArea : SystemInformation.WorkingArea;
            int gap = Px(8);

            SuspendLayout();
            Location = WindowPlacement.Fit(work, Size, Preferred(cursor), gap);

            // 窗口创建时系统可能按 DPI 上下文把窗口摆到别的显示器；发现 DPI 变了就按新比例重排再摆一次
            int dpi = DeviceDpi;
            if (dpi > 0 && dpi != _dpi)
            {
                _dpi = dpi;
                ApplyScale(dpi / 96F);
                Location = WindowPlacement.Fit(work, Size, Preferred(cursor), gap);
            }
            ResumeLayout(true);

            Log.Info(string.Format(
                "提问卡片：光标 {0},{1} · 缩放 {2:0.##} · 屏幕 {3}",
                cursor.X,
                cursor.Y,
                _scale,
                screen != null ? screen.DeviceName : "未知"));
        }

        /// <summary>卡片左上角的期望位置：横向居中于光标，纵向在光标下方一点。</summary>
        private Point Preferred(Point cursor)
        {
            return new Point(cursor.X - Width / 2, cursor.Y + Px(20));
        }

        /// <summary>前台窗口所在显示器；取不到时用光标所在显示器。</summary>
        private static Screen TargetScreen(Point cursor)
        {
            Screen atCursor = Screen.FromPoint(cursor);
            Screen foreground = ForegroundScreen();
            if (foreground != null && atCursor != null
                && !string.Equals(foreground.DeviceName, atCursor.DeviceName, StringComparison.Ordinal))
            {
                return foreground;
            }
            return atCursor != null ? atCursor : Screen.PrimaryScreen;
        }

        /// <summary>别的进程的前台窗口所在的显示器；自己的窗口（托盘菜单等）不算。</summary>
        private static Screen ForegroundScreen()
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero)
                {
                    return null;
                }
                uint owner;
                GetWindowThreadProcessId(hwnd, out owner);
                if (owner == (uint)Process.GetCurrentProcess().Id)
                {
                    return null;
                }
                return Screen.FromHandle(hwnd);
            }
            catch (Exception)
            {
                return null;
            }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;

            // 卡片描边（白底来自 BackColor）
            using (GraphicsPath card = Rounded(new Rectangle(0, 0, Width - 1, Height - 1), Px(DesignCardRadius)))
            using (Pen pen = new Pen(Line))
            {
                g.DrawPath(pen, card);
            }

            // 鱼肚：浅蓝圆角凹槽，输入框就落在里面
            using (GraphicsPath belly = Rounded(Scale(BellyRect), Px(DesignBellyRadius)))
            {
                using (SolidBrush fill = new SolidBrush(Belly))
                {
                    g.FillPath(fill, belly);
                }
                using (Pen pen = new Pen(BellyLine))
                {
                    g.DrawPath(pen, belly);
                }
            }

            DrawMascot(g);
        }

        /// <summary>小鲸鱼 + 头顶一个问号（问号带个小尾巴，像个思考气泡）。</summary>
        private void DrawMascot(Graphics g)
        {
            Rectangle box = Scale(MascotRect);
            try
            {
                Bitmap whale = IconFactory.Mascot();
                ColorMatrix matrix = new ColorMatrix();
                matrix.Matrix33 = MascotOpacity;
                using (ImageAttributes attributes = new ImageAttributes())
                {
                    attributes.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                    g.DrawImage(
                        whale,
                        box,
                        0,
                        0,
                        whale.Width,
                        whale.Height,
                        GraphicsUnit.Pixel,
                        attributes);
                }
            }
            catch (InvalidOperationException)
            {
                // 没有内嵌鲸鱼也不该让提问框打不开：退回一个低调的圆形标记
                using (SolidBrush brush = new SolidBrush(Belly))
                {
                    g.FillEllipse(brush, box);
                }
            }

            // 问号气泡：白底 + 蓝边 + 蓝问号，压住鲸鱼头顶那一点点
            Rectangle badge = Scale(BadgeRect);
            using (SolidBrush fill = new SolidBrush(Color.White))
            {
                g.FillEllipse(fill, badge);
            }
            using (Pen ring = new Pen(Accent, 1.6F * _scale))
            {
                g.DrawEllipse(ring, badge);
            }
            using (SolidBrush ink = new SolidBrush(Accent))
            {
                StringFormat format = new StringFormat();
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                g.DrawString(
                    "?",
                    _badgeFont,
                    ink,
                    new RectangleF(badge.X, badge.Y, badge.Width, badge.Height + _scale),
                    format);
                format.Dispose();
            }
        }

        private void DragStart(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left)
            {
                return;
            }
            _dragging = true;
            _dragStart = Cursor.Position;
            _dragOrigin = Location;
        }

        private void DragMove(object sender, MouseEventArgs e)
        {
            if (!_dragging)
            {
                return;
            }
            Point now = Cursor.Position;
            Location = new Point(
                _dragOrigin.X + (now.X - _dragStart.X),
                _dragOrigin.Y + (now.Y - _dragStart.Y));
        }

        private void DragEnd(object sender, MouseEventArgs e)
        {
            _dragging = false;
        }

        private void OnSend(object sender, EventArgs e)
        {
            _question = (_input.Text ?? string.Empty).Trim();
            DialogResult = DialogResult.OK;
            Close();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // 显示后再摆一次：窗口创建时系统可能按 DPI 上下文把它挪到别的显示器
            PlaceCard();
            Activate();
            _input.Focus();
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            // 无边框窗口自己不刷背景会闪；统一填白
            using (SolidBrush brush = new SolidBrush(BackColor))
            {
                e.Graphics.FillRectangle(brush, ClientRectangle);
            }
        }

        /// <summary>
        /// 弹出输入框。
        /// </summary>
        /// <param name="selected">已经规整过的选中文字，只给用户瞄一眼。</param>
        /// <param name="template">留空时用的模板，仅用于提示文案。</param>
        /// <returns>null = 取消；空串 = 用默认模板；否则是用户写的问题。</returns>
        internal static string Ask(string selected, string template)
        {
            using (QuestionForm form = new QuestionForm(selected, template))
            {
                form.ShowDialog();
                if (form.DialogResult != DialogResult.OK)
                {
                    return null;
                }
                return form._question ?? string.Empty;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _titleFont.Dispose();
                _smallFont.Dispose();
                _badgeFont.Dispose();
                _inputFont.Dispose();
                _buttonFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
