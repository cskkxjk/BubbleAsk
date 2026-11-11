using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
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
    /// </summary>
    internal sealed class QuestionForm : Form
    {
        private static readonly Color Ink = Color.FromArgb(31, 41, 55);
        private static readonly Color Dim = Color.FromArgb(122, 131, 148);
        private static readonly Color Line = Color.FromArgb(226, 230, 239);
        private static readonly Color Belly = Color.FromArgb(239, 243, 255);
        private static readonly Color BellyLine = Color.FromArgb(214, 222, 252);
        private static readonly Color Accent = Color.FromArgb(77, 107, 254);

        /// <summary>卡片圆角与「鱼肚」圆角。</summary>
        private const int CardRadius = 14;
        private const int BellyRadius = 16;

        /// <summary>鲸鱼略微透明，避免压住旁边的文字。</summary>
        private const float MascotOpacity = 0.9F;

        private readonly TextBox _input;
        private readonly Font _titleFont;
        private readonly Font _smallFont;
        private readonly Font _badgeFont;
        private string _question;

        private bool _dragging;
        private Point _dragStart;
        private Point _dragOrigin;

        internal QuestionForm(string selected, string template)
        {
            string skeleton = ShortTemplate(template);
            _titleFont = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold);
            _smallFont = new Font("Microsoft YaHei UI", 8.5F);
            _badgeFont = new Font("Segoe UI", 9F, FontStyle.Bold);

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.White;
            Padding = new Padding(1);
            DoubleBuffered = true;
            KeyPreview = true;
            Text = "Bubble Ask · 抓词提问";
            ClientSize = new Size(452, 208);

            Label title = new Label();
            title.AutoSize = false;
            title.Bounds = new Rectangle(96, 24, 340, 22);
            title.ForeColor = Ink;
            title.Font = _titleFont;
            title.Text = "你想问什么？";
            title.MouseDown += DragStart;
            title.MouseMove += DragMove;
            title.MouseUp += DragEnd;
            Controls.Add(title);

            Label quote = new Label();
            quote.AutoSize = false;
            quote.Bounds = new Rectangle(96, 49, 340, 20);
            quote.ForeColor = Dim;
            quote.Font = _smallFont;
            quote.AutoEllipsis = true;
            quote.Text = selected ?? string.Empty;
            quote.MouseDown += DragStart;
            quote.MouseMove += DragMove;
            quote.MouseUp += DragEnd;
            Controls.Add(quote);

            _input = new TextBox();
            _input.Bounds = new Rectangle(34, 98, 384, 24);
            _input.BorderStyle = BorderStyle.None;
            _input.BackColor = Belly;
            _input.ForeColor = Ink;
            _input.Font = new Font("Microsoft YaHei UI", 10F);
            Controls.Add(_input);

            Label hint = new Label();
            hint.AutoSize = false;
            hint.Bounds = new Rectangle(20, 142, 412, 18);
            hint.ForeColor = Dim;
            hint.Font = _smallFont;
            hint.Text = "回车发送 · Esc 取消 · 留空则按模板「" + skeleton + "」提问";
            Controls.Add(hint);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Bounds = new Rectangle(286, 168, 66, 30);
            StyleButton(cancel, false);
            cancel.DialogResult = DialogResult.Cancel;
            Controls.Add(cancel);
            CancelButton = cancel;

            Button send = new Button();
            send.Text = "发送";
            send.Bounds = new Rectangle(360, 168, 74, 30);
            StyleButton(send, true);
            send.Click += OnSend;
            Controls.Add(send);
            AcceptButton = send;

            MouseDown += DragStart;
            MouseMove += DragMove;
            MouseUp += DragEnd;

            Point cursor = Cursor.Position;
            Rectangle work = Screen.FromPoint(cursor).WorkingArea;
            int left = Math.Min(Math.Max(work.Left + 8, cursor.X - Width / 2), work.Right - Width - 8);
            int top = Math.Min(Math.Max(work.Top + 8, cursor.Y + 20), work.Bottom - Height - 8);
            Location = new Point(left, top);
        }

        /// <summary>提示里只放模板骨架，太长的模板会把这一行撑爆。</summary>
        private static string ShortTemplate(string template)
        {
            string value = string.IsNullOrEmpty(template) ? PromptBuilder.DefaultTemplate : template.Trim();
            return value.Length <= 16 ? value : value.Substring(0, 15) + "…";
        }

        /// <summary>扁平按钮：主按钮实心蓝，次按钮白底细边，都切圆角。</summary>
        private static void StyleButton(Button button, bool primary)
        {
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = primary ? 0 : 1;
            button.FlatAppearance.BorderColor = Line;
            button.BackColor = primary ? Accent : Color.White;
            button.ForeColor = primary ? Color.White : Ink;
            button.Font = new Font("Microsoft YaHei UI", 9F);
            button.Cursor = Cursors.Hand;
            button.UseVisualStyleBackColor = false;
            using (GraphicsPath path = Rounded(new Rectangle(0, 0, button.Width - 1, button.Height - 1), 9))
            {
                button.Region = new Region(path);
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

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;

            // 卡片描边（白底来自 BackColor）
            using (GraphicsPath card = Rounded(new Rectangle(0, 0, Width - 1, Height - 1), CardRadius))
            using (Pen pen = new Pen(Line))
            {
                g.DrawPath(pen, card);
            }

            // 鱼肚：浅蓝圆角凹槽，输入框就落在里面
            using (GraphicsPath belly = Rounded(new Rectangle(18, 86, 416, 48), BellyRadius))
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
            Rectangle box = new Rectangle(18, 24, 64, 39);
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
            Rectangle badge = new Rectangle(30, 8, 22, 22);
            using (SolidBrush fill = new SolidBrush(Color.White))
            {
                g.FillEllipse(fill, badge);
            }
            using (Pen ring = new Pen(Accent, 1.6F))
            {
                g.DrawEllipse(ring, badge);
            }
            using (SolidBrush ink = new SolidBrush(Accent))
            {
                StringFormat format = new StringFormat();
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                g.DrawString("?", _badgeFont, ink, new RectangleF(badge.X, badge.Y, badge.Width, badge.Height + 1), format);
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
                if (_input != null && _input.Font != null)
                {
                    _input.Font.Dispose();
                }
            }
            base.Dispose(disposing);
        }
    }
}
