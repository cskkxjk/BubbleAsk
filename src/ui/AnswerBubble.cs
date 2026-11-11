using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BubbleAsk
{
    /// <summary>
    /// 自绘的气泡窗口：贴在鼠标旁，流式显示回答，并可以继续追问。
    /// 所有追加方法都假定在界面线程上调用；跨线程请用 Post。
    /// </summary>
    public class AnswerBubble : Form
    {
        // 和抓词提问卡片、扩展、DSH 插件同一套色板
        private static readonly Color Ink = Color.FromArgb(31, 41, 55);
        private static readonly Color Dim = Color.FromArgb(122, 131, 148);
        private static readonly Color Line = Color.FromArgb(226, 230, 239);
        private static readonly Color Hover = Color.FromArgb(243, 245, 250);
        private static readonly Color Belly = Color.FromArgb(239, 243, 255);
        private static readonly Color BellyLine = Color.FromArgb(214, 222, 252);
        private static readonly Color Accent = Color.FromArgb(77, 107, 254);
        private const int CardRadius = 14;

        private readonly AppConfig _config;
        private readonly Panel _header;
        private readonly PictureBox _mascot;
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

        // ---------- HTML 版（WebView2） ----------
        /// <summary>自测里置真：DrawToBitmap 抓不到 WebView2 的内容，渲染断言仍需原生那套。</summary>
        public static bool ForceNativeUi;

        /// <summary>自测里置假：离屏测试窗口的位置不该写进用户配置。</summary>
        public static bool PersistPosition = true;

        /// <summary>诊断用：HTML 版启用失败时的原因。</summary>
        public string WebUiError;

        /// <summary>诊断用：HTML 版是否已经就绪。</summary>
        public bool WebUiReady { get { return _web && _webReady; } }

        /// <summary>内嵌资源名：build.ps1 的 /resource:...,BubbleAsk.answer.html。</summary>
        private const string HtmlResourceName = "BubbleAsk.answer.html";

        private static bool? _webUiAvailable;
        private static string _htmlSource;

        private bool _web;
        private WebView2 _webView;
        private CoreWebView2 _core;
        private bool _webReady;
        private readonly List<string> _transcript = new List<string>();

        /// <summary>Windows 上有 WebView2 运行时就用 HTML 版；没有就退回原生自绘。</summary>
        private static bool WebUiAvailable()
        {
            if (_webUiAvailable.HasValue)
            {
                return _webUiAvailable.Value;
            }
            bool available;
            try
            {
                string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
                available = !string.IsNullOrEmpty(version);
            }
            catch
            {
                available = false;
            }
            _webUiAvailable = available;
            return available;
        }

        private static string HtmlSource()
        {
            if (_htmlSource != null)
            {
                return _htmlSource;
            }
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (System.IO.Stream stream = assembly.GetManifestResourceStream(HtmlResourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException(
                        "缺少内嵌资源 " + HtmlResourceName + "（build.ps1 的 /resource 参数漏了 answer.html？）");
                }
                using (System.IO.StreamReader reader = new System.IO.StreamReader(stream, Encoding.UTF8))
                {
                    _htmlSource = reader.ReadToEnd();
                }
            }
            return _htmlSource;
        }

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
            // 尺寸与网页版小窗统一（WindowWidth × WindowHeight）：两种模式看到的是同样大的面板。
            Width = config.WindowWidth > 240 ? config.WindowWidth : 480;
            Height = config.WindowHeight > 240 ? config.WindowHeight : 720;

            _header = new Panel();
            _header.Dock = DockStyle.Top;
            _header.Height = 46;
            _header.BackColor = Color.White;
            _header.Cursor = Cursors.SizeAll;
            _header.MouseDown += HeaderMouseDown;
            _header.MouseMove += HeaderMouseMove;
            _header.MouseUp += HeaderMouseUp;

            // 小鲸鱼：和抓词提问卡片、DSH 插件同一个形象
            PictureBox mascot = new PictureBox();
            mascot.Dock = DockStyle.Left;
            mascot.Width = 42;
            mascot.SizeMode = PictureBoxSizeMode.Zoom;
            mascot.BackColor = Color.Transparent;
            mascot.Cursor = Cursors.SizeAll;
            mascot.MouseDown += HeaderMouseDown;
            mascot.MouseMove += HeaderMouseMove;
            mascot.MouseUp += HeaderMouseUp;
            try
            {
                mascot.Image = IconFactory.Mascot();
            }
            catch (InvalidOperationException)
            {
                mascot.Width = 10;
            }
            _mascot = mascot;

            _title = new Label();
            _title.AutoSize = false;
            _title.Dock = DockStyle.Fill;
            _title.TextAlign = ContentAlignment.MiddleLeft;
            _title.Padding = new Padding(4, 0, 0, 0);
            _title.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
            _title.ForeColor = Ink;
            _title.Cursor = Cursors.SizeAll;
            _title.MouseDown += HeaderMouseDown;
            _title.MouseMove += HeaderMouseMove;
            _title.MouseUp += HeaderMouseUp;

            _close = new Button();
            _close.Text = "✕";
            _close.Bounds = new Rectangle(60, 9, 30, 28);
            _close.FlatStyle = FlatStyle.Flat;
            _close.FlatAppearance.BorderSize = 0;
            _close.Font = new Font("Microsoft YaHei UI", 10f);
            _close.ForeColor = Dim;
            _close.BackColor = Color.White;
            _close.TabStop = false;
            _close.Cursor = Cursors.Hand;
            _close.Click += delegate { Close(); };
            AddHover(_close, Color.White, Hover);

            _copy = new Button();
            _copy.Text = "复制";
            _copy.Bounds = new Rectangle(8, 12, 48, 24);
            _copy.FlatStyle = FlatStyle.Flat;
            _copy.FlatAppearance.BorderSize = 0;
            _copy.Font = new Font("Microsoft YaHei UI", 8.5f);
            _copy.ForeColor = Dim;
            _copy.BackColor = Color.White;
            _copy.TabStop = false;
            _copy.Cursor = Cursors.Hand;
            _copy.Click += delegate { CopyAll(); };
            AddHover(_copy, Color.White, Hover);

            Panel headerRight = new Panel();
            headerRight.Dock = DockStyle.Right;
            headerRight.Width = 96;
            headerRight.BackColor = Color.Transparent;
            headerRight.Controls.Add(_copy);
            headerRight.Controls.Add(_close);

            _header.Controls.Add(_title);
            _header.Controls.Add(headerRight);
            _header.Controls.Add(_mascot);

            _thinking = new Label();
            _thinking.Dock = DockStyle.Top;
            _thinking.Height = 0;
            _thinking.AutoSize = false;
            _thinking.Font = new Font("Microsoft YaHei UI", 9f);
            _thinking.ForeColor = Dim;
            _thinking.BackColor = Color.White;
            _thinking.Padding = new Padding(18, 6, 18, 0);
            _thinking.Visible = false;

            _bodyFont = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Regular);
            _italicFont = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Italic);

            _body = new RichTextBox();
            _body.Dock = DockStyle.Fill;
            _body.BorderStyle = BorderStyle.None;
            _body.ReadOnly = true;
            _body.BackColor = Color.White;
            _body.ForeColor = Ink;
            _body.Font = _bodyFont;
            _body.DetectUrls = true;
            _body.Margin = new Padding(0);
            _body.ScrollBars = RichTextBoxScrollBars.Vertical;

            // RichTextBox 不吃 Padding，套一层带留白的面板，文字才不会贴着边框。
            Panel bodyHost = new Panel();
            bodyHost.Dock = DockStyle.Fill;
            bodyHost.BackColor = Color.White;
            bodyHost.Padding = new Padding(18, 10, 12, 8);
            bodyHost.Controls.Add(_body);

            // 页脚：白底、上一条细线，输入框做成浅蓝「鱼肚」，发送键是圆角实心蓝。
            _footer = new Panel();
            _footer.Dock = DockStyle.Bottom;
            _footer.Height = 62;
            _footer.BackColor = Color.White;
            _footer.Padding = new Padding(14, 12, 14, 12);

            Panel belly = new Panel();
            belly.Dock = DockStyle.Fill;
            belly.BackColor = Belly;
            belly.Padding = new Padding(10, 5, 10, 5);
            belly.Resize += delegate
            {
                using (GraphicsPath path = Rounded(new Rectangle(0, 0, belly.Width - 1, belly.Height - 1), 12))
                {
                    belly.Region = new Region(path);
                }
            };
            belly.Paint += delegate(object sender, PaintEventArgs args)
            {
                Panel panel = (Panel)sender;
                args.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (GraphicsPath path = Rounded(new Rectangle(1, 1, panel.Width - 3, panel.Height - 3), 11))
                using (Pen pen = new Pen(BellyLine))
                {
                    args.Graphics.DrawPath(pen, path);
                }
            };

            _input = new TextBox();
            _input.Dock = DockStyle.Fill;
            _input.BorderStyle = BorderStyle.None;
            _input.BackColor = Belly;
            _input.ForeColor = Ink;
            _input.Font = new Font("Microsoft YaHei UI", 10f);
            _input.KeyDown += InputKeyDown;
            belly.Controls.Add(_input);

            _send = new Button();
            _send.Text = "追问";
            _send.FlatStyle = FlatStyle.Flat;
            _send.FlatAppearance.BorderSize = 0;
            _send.BackColor = Accent;
            _send.ForeColor = Color.White;
            _send.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
            _send.Cursor = Cursors.Hand;
            _send.Click += delegate { SubmitFollowUp(); };
            _send.Resize += delegate
            {
                using (GraphicsPath path = Rounded(new Rectangle(0, 0, _send.Width - 1, _send.Height - 1), 10))
                {
                    _send.Region = new Region(path);
                }
            };

            Panel sendHost = new Panel();
            sendHost.Dock = DockStyle.Right;
            sendHost.Width = 84;
            sendHost.BackColor = Color.White;
            sendHost.Padding = new Padding(12, 0, 0, 0);
            _send.Dock = DockStyle.Fill;
            sendHost.Controls.Add(_send);

            _footer.Controls.Add(belly);
            _footer.Controls.Add(sendHost);

            Controls.Add(bodyHost);
            Controls.Add(_footer);
            Controls.Add(_thinking);
            // 标题栏和正文之间的 1px 分隔：用一条实体 Panel 而不是 OnPaint 画线，
            // 因为标题栏和正文都是子控件，会盖住窗体自己画的那条线。
            Panel divider = new Panel();
            divider.Dock = DockStyle.Top;
            divider.Height = 1;
            divider.BackColor = Line;
            Controls.Add(divider);
            Controls.Add(_header);

            // 有 WebView2 运行时就用 HTML 版盖住原生界面；没有就继续用自绘那套。
            _web = !ForceNativeUi && WebUiAvailable();
            if (_web)
            {
                AttachWebUi();
            }

            FormClosed += delegate
            {
                RememberPosition();
                if (Dismissed != null)
                {
                    Dismissed();
                }
            };
        }

        /// <summary>
        /// 关窗时把位置记进配置：下次开起来还在原地（网页版小窗也读这一份）。
        /// 窗口被拖到屏幕外/最小化状态就跳过，别把 -32000 存进去。
        /// </summary>
        private void RememberPosition()
        {
            if (!PersistPosition || _config == null || WindowState != FormWindowState.Normal)
            {
                return;
            }
            if (Left < -20000 || Top < -20000)
            {
                return;
            }
            if (_config.WindowX == Left && _config.WindowY == Top)
            {
                return;
            }
            _config.WindowX = Left;
            _config.WindowY = Top;
            try
            {
                _config.Save();
            }
            catch
            {
                /* 配置写不进去（只读目录等）不影响使用 */
            }
        }

        //#region HTML 版：WebView2 承载内嵌的 answer.html
        /// <summary>
        /// 用 WebView2 盖住原生界面（原生那套仍然在，作为初始化失败时的兜底，
        /// 也作为 BodyText / 自测渲染断言的来源）。
        /// </summary>
        private void AttachWebUi()
        {
            try
            {
                _webView = new WebView2();
                _webView.Dock = DockStyle.Fill;
                _webView.DefaultBackgroundColor = Color.White;
                // 把原生那套藏起来（不是删掉）：WinForms 的 Dock 布局只给可见控件留位置，
                // 藏着它们 webview 才能真正铺满整块；同时它们仍是初始化失败时的兜底。
                foreach (Control child in Controls)
                {
                    child.Visible = false;
                }
                Controls.Add(_webView);
                _webView.BringToFront();
                _webView.CoreWebView2InitializationCompleted += OnWebViewInitialized;
                _webView.EnsureCoreWebView2Async(null);
            }
            catch
            {
                // 初始化失败：拆掉 webview，回到原生界面
                _web = false;
                if (_webView != null)
                {
                    Controls.Remove(_webView);
                    _webView.Dispose();
                    _webView = null;
                }
                AdjustHeight();
            }
        }

        private void OnWebViewInitialized(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (!e.IsSuccess || _webView == null)
            {
                _web = false;
                return;
            }
            _core = _webView.CoreWebView2;
            _core.Settings.AreDefaultContextMenusEnabled = false;
            _core.Settings.AreDevToolsEnabled = false;
            _core.Settings.IsStatusBarEnabled = false;
            _core.WebMessageReceived += OnWebMessage;
            _core.NavigationCompleted += OnWebNavigationCompleted;
            _core.NavigateToString(HtmlSource());
        }

        private void OnWebNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                return;
            }
            _webReady = true;
            // 页面就绪前攒下的调用按原顺序补发一次
            string[] queued = _transcript.ToArray();
            _transcript.Clear();
            for (int i = 0; i < queued.Length; i += 1)
            {
                RunScript(queued[i]);
            }
        }

        /// <summary>调用页面里的 ds.* 接口；页面没就绪就先攒着。</summary>
        private void Js(string script)
        {
            if (!_web)
            {
                return;
            }
            if (!_webReady)
            {
                _transcript.Add(script);
                return;
            }
            RunScript(script);
        }

        private void RunScript(string script)
        {
            try
            {
                if (_core != null)
                {
                    _core.ExecuteScriptAsync(script);
                }
            }
            catch
            {
                /* 页面在导航中/已销毁：忽略，原生界面还有一份内容 */
            }
        }

        /// <summary>页面 → 宿主：字符串协议（"followup:…" / "copy:…" / "height:…" …）。</summary>
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string message;
            try
            {
                message = e.TryGetWebMessageAsString();
            }
            catch
            {
                return;
            }
            if (string.IsNullOrEmpty(message))
            {
                return;
            }
            int split = message.IndexOf(':');
            string kind = split >= 0 ? message.Substring(0, split) : message;
            string body = split >= 0 ? message.Substring(split + 1) : string.Empty;

            if (kind == "followup")
            {
                if (!string.IsNullOrEmpty(body) && FollowUp != null)
                {
                    FollowUp(body);
                }
                return;
            }
            if (kind == "copy")
            {
                try
                {
                    Clipboard.SetText(body ?? string.Empty);
                }
                catch
                {
                    /* 剪贴板被占用：静默 */
                }
                return;
            }
            if (kind == "close")
            {
                Close();
                return;
            }
            if (kind == "drag")
            {
                ReleaseCapture();
                SendMessage(Handle, 0xA1, 0x2, 0);
                return;
            }
            if (kind == "height")
            {
                // 尺寸已固定成「窗口尺寸」，页面报上来的高度不再改变窗口大小
                // （内容超出时由正文自己滚动）。留这个分支是为了协议完整、方便排查。
                return;
            }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        /// <summary>
        /// 诊断/自测用：把 WebView2 当前画面存成 PNG。没启用 HTML 版（或还没就绪）返回 false。
        /// DrawToBitmap 抓不到 WebView2 的内容，只能走引擎自己的截图接口。
        /// </summary>
        public bool CaptureWebUi(string path)
        {
            if (!_web || _core == null || !_webReady || string.IsNullOrEmpty(path))
            {
                return false;
            }
            try
            {
                using (System.IO.FileStream stream = System.IO.File.Create(path))
                {
                    _core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream).Wait(8000);
                }
            }
            catch
            {
                return false;
            }
            return System.IO.File.Exists(path) && new System.IO.FileInfo(path).Length > 0;
        }
        //#endregion

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
            Js("ds.setTitle(" + Json.Stringify(text ?? string.Empty) + ")");
        }

        public void BeginTurn(string question)
        {
            SetStreaming(true);
            _thinking.Text = "";
            _thinking.Visible = false;
            _thinking.Height = 0;
            AppendParagraph("你： " + (question ?? ""), Color.FromArgb(90, 90, 100), false);
            Js("ds.beginTurn(" + Json.Stringify(question ?? string.Empty) + ")");
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
            Js("ds.appendReasoning(" + Json.Stringify(delta) + ")");
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
            Js("ds.appendAnswer(" + Json.Stringify(delta) + ")");
        }

        public void EndTurn()
        {
            _thinking.Visible = false;
            _thinking.Height = 0;
            AppendRaw("\n", Color.FromArgb(31, 41, 55));
            Js("ds.endTurn()");
            SetStreaming(false);
            AdjustHeight();
        }

        public void FailTurn(string message)
        {
            _thinking.Visible = false;
            _thinking.Height = 0;
            AppendParagraph("⚠ " + (message ?? "出错了"), Color.FromArgb(185, 28, 28), false);
            Js("ds.failTurn(" + Json.Stringify(message ?? string.Empty) + ")");
            SetStreaming(false);
            AdjustHeight();
        }

        /// <summary>把一段文字直接塞进正文（例如“已复制”提示）。</summary>
        public void Note(string text)
        {
            AppendParagraph(text, Color.FromArgb(107, 114, 128), true);
            Js("ds.note(" + Json.Stringify(text ?? string.Empty) + ")");
            AdjustHeight();
        }

        /// <summary>把光标放到追问输入框。</summary>
        public void FocusInput()
        {
            if (_input.Enabled)
            {
                _input.Focus();
            }
            Js("ds.focusInput()");
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

        /// <summary>只在第一次显示时定位；后续换问题沿用用户拖到的位置。</summary>
        public void ShowForAsk()
        {
            if (!Visible)
            {
                // 和网页版小窗同一个位置：存过的位置优先，没有就右侧居中；拖动会记住。
                Location = WindowPlacement.Resolve(_config, Size);
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
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

            // 卡片外描边（标题栏与正文之间的分隔由 divider 那条 Panel 负责）
            using (GraphicsPath path = RoundedPath())
            using (Pen pen = new Pen(Line))
            {
                e.Graphics.DrawPath(pen, path);
            }
        }

        /// <summary>无边框窗口也给一点系统投影，别像贴在桌面上的纸片。</summary>
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ClassStyle = parameters.ClassStyle | 0x00020000; // CS_DROPSHADOW
                return parameters;
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
            Invalidate();
        }

        private GraphicsPath RoundedPath()
        {
            GraphicsPath path = new GraphicsPath();
            int width = Math.Max(CardRadius * 2 + 1, Width - 1);
            int height = Math.Max(CardRadius * 2 + 1, Height - 1);
            path.AddArc(0, 0, CardRadius, CardRadius, 180, 90);
            path.AddArc(width - CardRadius, 0, CardRadius, CardRadius, 270, 90);
            path.AddArc(width - CardRadius, height - CardRadius, CardRadius, CardRadius, 0, 90);
            path.AddArc(0, height - CardRadius, CardRadius, CardRadius, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>圆角矩形路径（按钮 / 鱼肚输入框用）。</summary>
        private static GraphicsPath Rounded(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int diameter = Math.Max(2, radius);
            int width = Math.Max(diameter + 1, bounds.Width);
            int height = Math.Max(diameter + 1, bounds.Height);
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.X + width - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.X + width - diameter, bounds.Y + height - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Y + height - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>给无边框按钮补一个悬停底色（原生 FlatButton 不会自己画）。</summary>
        private static void AddHover(Button button, Color normal, Color hover)
        {
            button.MouseEnter += delegate { button.BackColor = hover; };
            button.MouseLeave += delegate { button.BackColor = normal; };
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
        /// <summary>
        /// 尺寸固定为「窗口尺寸」（和网页版小窗一致），不再按内容伸缩 ——
        /// 回答长了就在正文里自己滚动。这里只负责把被改过的尺寸拉回来。
        /// </summary>
        private void AdjustHeight()
        {
            int width = _config.WindowWidth > 240 ? _config.WindowWidth : 480;
            int height = _config.WindowHeight > 240 ? _config.WindowHeight : 720;
            if (Width != width || Height != height)
            {
                Size = new Size(width, height);
            }
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
