using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>
    /// 自绘的气泡窗口：贴在鼠标旁，流式显示回答，并可以继续追问。
    /// 所有追加方法都假定在界面线程上调用；跨线程请用 Post。
    /// </summary>
    public class AnswerBubble : Form
    {
        private readonly AppConfig _config;
        private readonly Panel _header;
        private readonly Label _title;
        private readonly Label _thinking;
        private readonly RichTextBox _body;
        private readonly Panel _footer;
        private readonly TextBox _input;
        private readonly Button _send;
        private readonly Button _close;
        private readonly Button _copy;
        private readonly Font _bodyFont;
        private readonly Font _italicFont;

        private bool _streaming;
        private bool _dragging;
        private Point _dragOrigin;
        private Point _formOrigin;

        public event Action<string> FollowUp;
        public event Action Dismissed;

        public AnswerBubble(AppConfig config)
        {
            _config = config;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.White;
            Padding = new Padding(1);
            KeyPreview = true;
            DoubleBuffered = true;
            Text = "Bubble Ask";
            Width = config.BubbleWidth > 240 ? config.BubbleWidth : 460;
            Height = 280;

            _header = new Panel();
            _header.Dock = DockStyle.Top;
            _header.Height = 40;
            _header.BackColor = Color.FromArgb(238, 242, 255);
            _header.Cursor = Cursors.SizeAll;
            _header.MouseDown += HeaderMouseDown;
            _header.MouseMove += HeaderMouseMove;
            _header.MouseUp += HeaderMouseUp;

            _title = new Label();
            _title.AutoSize = false;
            _title.Dock = DockStyle.Fill;
            _title.TextAlign = ContentAlignment.MiddleLeft;
            _title.Padding = new Padding(12, 0, 0, 0);
            _title.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            _title.ForeColor = Color.FromArgb(31, 41, 55);
            _title.Cursor = Cursors.SizeAll;
            _title.MouseDown += HeaderMouseDown;
            _title.MouseMove += HeaderMouseMove;
            _title.MouseUp += HeaderMouseUp;

            _close = new Button();
            _close.Text = "×";
            _close.Bounds = new Rectangle(60, 4, 36, 30);
            _close.FlatStyle = FlatStyle.Flat;
            _close.FlatAppearance.BorderSize = 0;
            _close.Font = new Font("Microsoft YaHei UI", 12f);
            _close.ForeColor = Color.FromArgb(75, 85, 99);
            _close.TabStop = false;
            _close.Click += delegate { Close(); };

            _copy = new Button();
            _copy.Text = "复制";
            _copy.Bounds = new Rectangle(12, 9, 48, 24);
            _copy.FlatStyle = FlatStyle.Flat;
            _copy.FlatAppearance.BorderSize = 0;
            _copy.Font = new Font("Microsoft YaHei UI", 8.5f);
            _copy.ForeColor = Color.FromArgb(55, 65, 81);
            _copy.TabStop = false;
            _copy.Click += delegate { CopyAll(); };

            Panel headerRight = new Panel();
            headerRight.Dock = DockStyle.Right;
            headerRight.Width = 100;
            headerRight.BackColor = Color.Transparent;
            headerRight.Controls.Add(_copy);
            headerRight.Controls.Add(_close);

            _header.Controls.Add(_title);
            _header.Controls.Add(headerRight);

            _thinking = new Label();
            _thinking.Dock = DockStyle.Top;
            _thinking.Height = 0;
            _thinking.AutoSize = false;
            _thinking.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Italic);
            _thinking.ForeColor = Color.FromArgb(120, 120, 130);
            _thinking.Padding = new Padding(12, 4, 12, 0);
            _thinking.Visible = false;

            _bodyFont = new Font("Microsoft YaHei UI", 10f, FontStyle.Regular);
            _italicFont = new Font("Microsoft YaHei UI", 10f, FontStyle.Italic);

            _body = new RichTextBox();
            _body.Dock = DockStyle.Fill;
            _body.BorderStyle = BorderStyle.None;
            _body.ReadOnly = true;
            _body.BackColor = Color.White;
            _body.ForeColor = Color.FromArgb(31, 41, 55);
            _body.Font = _bodyFont;
            _body.DetectUrls = true;
            _body.Margin = new Padding(0);
            _body.ScrollBars = RichTextBoxScrollBars.Vertical;

            // RichTextBox 不吃 Padding，套一层带留白的面板，文字才不会贴着边框。
            Panel bodyHost = new Panel();
            bodyHost.Dock = DockStyle.Fill;
            bodyHost.BackColor = Color.White;
            bodyHost.Padding = new Padding(14, 8, 10, 6);
            bodyHost.Controls.Add(_body);

            _footer = new Panel();
            _footer.Dock = DockStyle.Bottom;
            _footer.Height = 54;
            _footer.BackColor = Color.FromArgb(249, 250, 251);
            _footer.Padding = new Padding(10, 10, 10, 10);

            _input = new TextBox();
            _input.Dock = DockStyle.Fill;
            _input.BorderStyle = BorderStyle.FixedSingle;
            _input.Font = new Font("Microsoft YaHei UI", 10f);
            _input.KeyDown += InputKeyDown;

            _send = new Button();
            _send.Text = "追问";
            _send.Dock = DockStyle.Right;
            _send.Width = 64;
            _send.FlatStyle = FlatStyle.Flat;
            _send.FlatAppearance.BorderSize = 0;
            _send.BackColor = Color.FromArgb(77, 107, 254);
            _send.ForeColor = Color.White;
            _send.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
            _send.Click += delegate { SubmitFollowUp(); };

            _footer.Controls.Add(_input);
            _footer.Controls.Add(_send);

            Controls.Add(bodyHost);
            Controls.Add(_footer);
            Controls.Add(_thinking);
            Controls.Add(_header);

            FormClosed += delegate
            {
                if (Dismissed != null)
                {
                    Dismissed();
                }
            };
        }

        public bool IsStreaming
        {
            get { return _streaming; }
        }

        /// <summary>气泡是不是当前前台窗口——用来做“再按一次收起”。</summary>
        public bool IsForegroundWindow
        {
            get { return !IsDisposed && Visible && GetForegroundWindow() == Handle; }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        /// <summary>正文全文，自测与“复制”用。</summary>
        public string BodyText
        {
            get { return _body.Text; }
        }

        /// <summary>主题用的模型名，显示在标题栏。</summary>
        public void SetTitle(string text)
        {
            _title.Text = text;
        }

        public void BeginTurn(string question)
        {
            SetStreaming(true);
            _thinking.Text = "";
            _thinking.Visible = false;
            _thinking.Height = 0;
            AppendParagraph("你： " + (question ?? ""), Color.FromArgb(90, 90, 100), false);
            _body.SelectionStart = _body.TextLength;
            _body.ScrollToCaret();
            AdjustHeight();
        }

        public void AppendReasoning(string delta)
        {
            if (string.IsNullOrEmpty(delta))
            {
                return;
            }
            string current = _thinking.Text;
            string next = current + delta;
            if (next.Length > 90)
            {
                next = next.Substring(next.Length - 90);
            }
            _thinking.Text = "思考中：" + next.Replace("\r", " ").Replace("\n", " ");
            if (!_thinking.Visible)
            {
                _thinking.Visible = true;
                _thinking.Height = 26;
                AdjustHeight();
            }
        }

        public void AppendAnswer(string delta)
        {
            if (string.IsNullOrEmpty(delta))
            {
                return;
            }
            if (_thinking.Visible)
            {
                _thinking.Visible = false;
                _thinking.Height = 0;
            }
            AppendRaw(delta, Color.FromArgb(31, 41, 55));
        }

        public void EndTurn()
        {
            _thinking.Visible = false;
            _thinking.Height = 0;
            AppendRaw("\n", Color.FromArgb(31, 41, 55));
            SetStreaming(false);
            AdjustHeight();
        }

        public void FailTurn(string message)
        {
            _thinking.Visible = false;
            _thinking.Height = 0;
            AppendParagraph("⚠ " + (message ?? "出错了"), Color.FromArgb(185, 28, 28), false);
            SetStreaming(false);
            AdjustHeight();
        }

        /// <summary>把一段文字直接塞进正文（例如“已复制”提示）。</summary>
        public void Note(string text)
        {
            AppendParagraph(text, Color.FromArgb(107, 114, 128), true);
            AdjustHeight();
        }

        /// <summary>把光标放到追问输入框。</summary>
        public void FocusInput()
        {
            if (_input.Enabled)
            {
                _input.Focus();
            }
        }

        /// <summary>和用户在输入框里按回车等价；自测与托盘菜单复用这条路径。</summary>
        public void AskFollowUp(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return;
            }
            _input.Text = text;
            SubmitFollowUp();
        }

        public void Post(Action action)
        {
            if (action == null)
            {
                return;
            }
            if (IsDisposed)
            {
                return;
            }
            try
            {
                if (InvokeRequired)
                {
                    BeginInvoke(new MethodInvoker(action));
                }
                else
                {
                    action();
                }
            }
            catch (ObjectDisposedException)
            {
            }
            catch (InvalidOperationException)
            {
            }
        }

        /// <summary>贴到鼠标右下角，越界时翻转，保证整块可见。</summary>
        public void PlaceNearCursor()
        {
            Point cursor = Cursor.Position;
            Rectangle screen = Screen.FromPoint(cursor).WorkingArea;
            int x = cursor.X + 14;
            int y = cursor.Y + 14;
            if (x + Width > screen.Right - 8)
            {
                x = cursor.X - Width - 14;
            }
            if (y + Height > screen.Bottom - 8)
            {
                y = cursor.Y - Height - 14;
            }
            if (x < screen.Left + 8)
            {
                x = screen.Left + 8;
            }
            if (y < screen.Top + 8)
            {
                y = screen.Top + 8;
            }
            Location = new Point(x, y);
        }

        /// <summary>只在第一次显示时定位；后续换问题沿用用户拖到的位置。</summary>
        public void ShowForAsk()
        {
            if (!Visible)
            {
                if (_config.ShowBubble)
                {
                    PlaceNearCursor();
                }
                else
                {
                    Rectangle screen = Screen.FromPoint(Cursor.Position).WorkingArea;
                    Location = new Point(screen.Left + (screen.Width - Width) / 2,
                        screen.Top + (screen.Height - Height) / 2);
                }
                Show();
            }
            else
            {
                Activate();
            }
        }

        private void CopyAll()
        {
            try
            {
                if (_body.SelectionLength > 0)
                {
                    Clipboard.SetText(_body.SelectedText);
                }
                else
                {
                    Clipboard.SetText(_body.Text);
                }
            }
            catch (Exception error)
            {
                Log.Warn("复制失败: " + error.Message);
                return;
            }
            _copy.Text = "已复制";
            Timer timer = new Timer();
            timer.Interval = 1200;
            timer.Tick += delegate
            {
                timer.Stop();
                _copy.Text = "复制";
                timer.Dispose();
            };
            timer.Start();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape)
            {
                Close();
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (GraphicsPath path = RoundedPath())
            {
                using (Pen pen = new Pen(Color.FromArgb(203, 213, 225)))
                {
                    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    e.Graphics.DrawPath(pen, path);
                }
            }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            using (GraphicsPath path = RoundedPath())
            {
                Region old = Region;
                Region = new Region(path);
                if (old != null)
                {
                    old.Dispose();
                }
            }
        }

        private GraphicsPath RoundedPath()
        {
            int radius = 10;
            GraphicsPath path = new GraphicsPath();
            int width = Math.Max(radius * 2 + 1, Width - 1);
            int height = Math.Max(radius * 2 + 1, Height - 1);
            path.AddArc(0, 0, radius, radius, 180, 90);
            path.AddArc(width - radius, 0, radius, radius, 270, 90);
            path.AddArc(width - radius, height - radius, radius, radius, 0, 90);
            path.AddArc(0, height - radius, radius, radius, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_bodyFont != null)
                {
                    _bodyFont.Dispose();
                }
                if (_italicFont != null)
                {
                    _italicFont.Dispose();
                }
            }
            base.Dispose(disposing);
        }

        private void SetStreaming(bool streaming)
        {
            _streaming = streaming;
            _input.Enabled = !streaming;
            _send.Enabled = !streaming;
            if (streaming)
            {
                _input.Text = "";
                Cursor = Cursors.Default;
            }
            else
            {
                _input.Focus();
            }
        }

        private void AppendParagraph(string text, Color color, bool italic)
        {
            _body.SelectionStart = _body.TextLength;
            _body.SelectionLength = 0;
            _body.SelectionFont = italic ? _italicFont : _bodyFont;
            _body.SelectionColor = color;
            _body.AppendText(text + Environment.NewLine);
            _body.SelectionStart = _body.TextLength;
            _body.ScrollToCaret();
        }

        private void AppendRaw(string text, Color color)
        {
            _body.SelectionStart = _body.TextLength;
            _body.SelectionLength = 0;
            _body.SelectionColor = color;
            _body.AppendText(text);
            _body.SelectionStart = _body.TextLength;
            _body.ScrollToCaret();
        }

        /// <summary>内容变长时跟着长高，最多到配置的上限。</summary>
        private void AdjustHeight()
        {
            int maxHeight = _config.BubbleMaxHeight > 240 ? _config.BubbleMaxHeight : 560;
            Point last = _body.GetPositionFromCharIndex(_body.TextLength);
            int chrome = _header.Height + _footer.Height + (_thinking.Visible ? _thinking.Height : 0) + 40;
            int desired = last.Y + _body.Font.Height + chrome;
            int target = Math.Max(240, Math.Min(maxHeight, desired));
            if (target == Height)
            {
                return;
            }
            int bottomLimit = Screen.FromPoint(Location).WorkingArea.Bottom - 8;
            int newTop = Math.Max(Screen.FromPoint(Location).WorkingArea.Top + 8, Math.Min(Top, bottomLimit - target));
            Bounds = new Rectangle(Left, newTop, Width, target);
            _body.SelectionStart = _body.TextLength;
            _body.ScrollToCaret();
        }

        private void SubmitFollowUp()
        {
            string text = (_input.Text ?? "").Trim();
            if (text.Length == 0 || _streaming)
            {
                return;
            }
            _input.Text = "";
            if (FollowUp != null)
            {
                FollowUp(text);
            }
        }

        private void InputKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true;
                SubmitFollowUp();
            }
        }

        private void HeaderMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left)
            {
                return;
            }
            _dragging = true;
            _dragOrigin = Cursor.Position;
            _formOrigin = Location;
        }

        private void HeaderMouseMove(object sender, MouseEventArgs e)
        {
            if (!_dragging)
            {
                return;
            }
            Point now = Cursor.Position;
            Location = new Point(_formOrigin.X + (now.X - _dragOrigin.X), _formOrigin.Y + (now.Y - _dragOrigin.Y));
        }

        private void HeaderMouseUp(object sender, MouseEventArgs e)
        {
            _dragging = false;
        }
    }
}
