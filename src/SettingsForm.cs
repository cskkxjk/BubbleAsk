using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>设置窗口：左侧导航 + 右侧表单，保存后由 TrayContext 重注册热键。</summary>
    public class SettingsForm : Form
    {
        private static readonly Color Accent = Color.FromArgb(77, 107, 254);
        private static readonly Color AccentSoft = Color.FromArgb(238, 242, 255);
        private static readonly Color Ink = Color.FromArgb(31, 41, 55);
        private static readonly Color Muted = Color.FromArgb(107, 114, 128);
        private static readonly Color Line = Color.FromArgb(229, 231, 235);
        private static readonly Color Canvas = Color.FromArgb(247, 248, 250);

        private readonly AppConfig _config;
        private readonly List<Button> _nav = new List<Button>();
        private readonly List<Panel> _pages = new List<Panel>();
        private readonly Font _navFont;
        private readonly Font _navFontBold;
        private Icon _windowIcon;
        private Panel _navPanel;
        private int _selectedPage = -1;

        private TextBox _template;
        private TextBox _shotPrompt;
        private ComboBox _mode;
        private CheckBox _autoSend;
        private CheckBox _autoStart;
        private NumericUpDown _maxChars;
        private Label _status;

        private TextBox _chatUrl;
        private NumericUpDown _width;
        private NumericUpDown _height;
        private CheckBox _topMost;
        private TextBox _edgePath;
        private TextBox _profileDir;
        private NumericUpDown _cdpPort;
        private NumericUpDown _bubbleWidth;
        private NumericUpDown _bubbleHeight;
        private CheckBox _showBubble;

        private TextBox _hotkeySummon;
        private TextBox _hotkeyAsk;
        private TextBox _hotkeyShot;

        private ComboBox _provider;
        private TextBox _apiBase;
        private TextBox _apiKey;
        private TextBox _apiModel;
        private NumericUpDown _apiMaxTokens;
        private TextBox _systemPrompt;

        public SettingsForm(AppConfig config)
        {
            _config = config;
            _navFont = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            _navFontBold = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            BuildUi();
            LoadValues();
            ShowPage(0);
        }

        public int PageCount
        {
            get { return _pages.Count; }
        }

        public void ShowPage(int index)
        {
            if (index < 0 || index >= _pages.Count)
            {
                return;
            }
            for (int i = 0; i < _pages.Count; i++)
            {
                _pages[i].Visible = i == index;
                Button button = _nav[i];
                button.BackColor = i == index ? AccentSoft : Color.White;
                button.ForeColor = i == index ? Accent : Color.FromArgb(55, 65, 81);
                button.Font = i == index ? _navFontBold : _navFont;
            }
            _selectedPage = index;
            if (_navPanel != null)
            {
                _navPanel.Invalidate();
            }
        }

        private void BuildUi()
        {
            Text = "Bubble Ask · 设置";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(760, 660);
            MinimumSize = new Size(700, 600);
            BackColor = Canvas;
            Font = new Font("Microsoft YaHei UI", 9f);
            AutoScaleMode = AutoScaleMode.Font;
            DoubleBuffered = true;
            _windowIcon = IconFactory.Create(32);
            Icon = _windowIcon;

            Controls.Add(BuildBody());
            Controls.Add(BuildFooter());
            Controls.Add(BuildHeader());
        }

        private Panel BuildHeader()
        {
            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 72;
            header.BackColor = Color.White;
            header.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Line))
                {
                    e.Graphics.DrawLine(pen, 0, header.Height - 1, header.Width, header.Height - 1);
                }
            };

            PictureBox logo = new PictureBox();
            logo.Size = new Size(40, 40);
            logo.Location = new Point(20, 16);
            logo.SizeMode = PictureBoxSizeMode.Zoom;
            try
            {
                using (Icon icon = IconFactory.Create(40))
                {
                    logo.Image = icon.ToBitmap();
                }
            }
            catch
            {
            }

            Label title = new Label();
            title.Text = "Bubble Ask";
            title.AutoSize = true;
            title.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold);
            title.ForeColor = Ink;
            title.Location = new Point(72, 15);

            Label subtitle = new Label();
            subtitle.Text = "选中文字 · 一个热键 · 气泡里回答";
            subtitle.AutoSize = true;
            subtitle.Font = new Font("Microsoft YaHei UI", 8.5f);
            subtitle.ForeColor = Muted;
            subtitle.Location = new Point(74, 45);

            header.Controls.Add(logo);
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            return header;
        }

        private Panel BuildFooter()
        {
            Panel footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 64;
            footer.BackColor = Color.White;
            footer.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Line))
                {
                    e.Graphics.DrawLine(pen, 0, 0, footer.Width, 0);
                }
            };

            _status = new Label();
            _status.AutoSize = true;
            _status.ForeColor = Muted;
            _status.Location = new Point(24, 23);

            Button save = new Button();
            save.Text = "保存";
            save.Size = new Size(96, 34);
            save.FlatStyle = FlatStyle.Flat;
            save.FlatAppearance.BorderSize = 0;
            save.BackColor = Accent;
            save.ForeColor = Color.White;
            save.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            save.Cursor = Cursors.Hand;
            save.Click += delegate { SaveAndClose(); };

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Size = new Size(96, 34);
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.FlatAppearance.BorderSize = 1;
            cancel.FlatAppearance.BorderColor = Line;
            cancel.BackColor = Color.White;
            cancel.ForeColor = Color.FromArgb(55, 65, 81);
            cancel.Cursor = Cursors.Hand;
            cancel.DialogResult = DialogResult.Cancel;

            footer.Controls.Add(_status);
            footer.Controls.Add(save);
            footer.Controls.Add(cancel);
            footer.Resize += delegate { LayoutFooterButtons(footer, save, cancel); };
            footer.Layout += delegate { LayoutFooterButtons(footer, save, cancel); };

            AcceptButton = save;
            CancelButton = cancel;
            return footer;
        }

        private static void LayoutFooterButtons(Panel footer, Button save, Button cancel)
        {
            cancel.Location = new Point(footer.Width - cancel.Width - 24, 15);
            save.Location = new Point(cancel.Left - save.Width - 10, 15);
        }

        private Panel BuildBody()
        {
            Panel body = new Panel();
            body.Dock = DockStyle.Fill;
            body.BackColor = Canvas;

            Panel nav = new Panel();
            nav.Dock = DockStyle.Left;
            nav.Width = 176;
            nav.BackColor = Color.White;
            nav.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Line))
                {
                    e.Graphics.DrawLine(pen, nav.Width - 1, 0, nav.Width - 1, nav.Height);
                }
                if (_selectedPage >= 0)
                {
                    using (SolidBrush brush = new SolidBrush(Accent))
                    {
                        e.Graphics.FillRectangle(brush, 0, 12 + _selectedPage * 44, 3, 44);
                    }
                }
            };
            _navPanel = nav;

            Panel host = new Panel();
            host.Dock = DockStyle.Fill;
            host.BackColor = Canvas;
            host.Padding = new Padding(20, 18, 20, 18);

            AddPage(host, "基本", BuildBasicPage());
            AddPage(host, "窗口与网页", BuildWindowPage());
            AddPage(host, "热键", BuildHotkeyPage());
            AddPage(host, "API（可选）", BuildApiPage());

            // Dock 从后往前布局，导航栏要后加才能占住左边。
            body.Controls.Add(host);
            body.Controls.Add(nav);

            for (int i = 0; i < _nav.Count; i++)
            {
                // Dock=Top 时先加的在上，所以倒序插入。
                nav.Controls.Add(_nav[_nav.Count - 1 - i]);
                nav.Controls.SetChildIndex(_nav[_nav.Count - 1 - i], i);
            }

            Panel spacer = new Panel();
            spacer.Dock = DockStyle.Top;
            spacer.Height = 12;
            nav.Controls.Add(spacer);
            nav.Controls.SetChildIndex(spacer, 0);
            return body;
        }

        private void AddPage(Panel host, string title, Panel page)
        {
            page.Dock = DockStyle.Fill;
            page.BackColor = Color.White;
            page.Padding = new Padding(24, 20, 24, 20);
            page.AutoScroll = true;
            page.Visible = false;
            host.Controls.Add(page);
            _pages.Add(page);

            Button button = new Button();
            button.Text = title;
            button.TextAlign = ContentAlignment.MiddleLeft;
            button.Padding = new Padding(20, 0, 0, 0);
            button.Height = 44;
            button.Dock = DockStyle.Top;
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 0;
            button.BackColor = Color.White;
            button.ForeColor = Color.FromArgb(55, 65, 81);
            button.Font = _navFont;
            button.Cursor = Cursors.Hand;
            int index = _pages.Count - 1;
            button.Click += delegate { ShowPage(index); };
            _nav.Add(button);
        }

        private Panel BuildBasicPage()
        {
            TableLayoutPanel table = NewTable();
            _template = new TextBox();
            AddRow(table, "提问模板", _template, "用 %s 代表选中的文字，例如 什么是%s");

            _mode = new ComboBox();
            _mode.DropDownStyle = ComboBoxStyle.DropDownList;
            _mode.Items.Add(new ComboItem("web", "网页版：驱动 Edge 打开 DeepSeek"));
            _mode.Items.Add(new ComboItem("api", "API：直连模型，气泡里流式回答"));
            AddRow(table, "运行模式", _mode, "网页版用浏览器登录态、不花额度；API 模式需要 key，回答显示在气泡里");

            _shotPrompt = new TextBox();
            AddRow(table, "截图提问", _shotPrompt, "截完图自动带上的问句，不需要 %s");

            _maxChars = new NumericUpDown();
            _maxChars.Minimum = 50;
            _maxChars.Maximum = 8000;
            _maxChars.Increment = 50;
            AddRow(table, "最多截取字数", _maxChars, "超长内容会在中间省略");

            _autoSend = new CheckBox();
            _autoSend.Text = "填入后自动发送（不勾选则只填入，等我按回车）";
            _autoSend.AutoSize = true;
            _autoSend.ForeColor = Ink;
            AddRow(table, "发送方式", _autoSend, null);

            _autoStart = new CheckBox();
            _autoStart.Text = "开机自动启动（托盘常驻，热键随时可用）";
            _autoStart.AutoSize = true;
            _autoStart.ForeColor = Ink;
            AddRow(table, "开机启动", _autoStart, null);

            Panel page = new Panel();
            page.Controls.Add(table);
            return page;
        }

        private Panel BuildWindowPage()
        {
            TableLayoutPanel table = NewTable();
            _chatUrl = new TextBox();
            AddRow(table, "聊天地址", _chatUrl, "默认 https://chat.deepseek.com/");

            _width = new NumericUpDown();
            _width.Minimum = 320;
            _width.Maximum = 1200;
            _width.Increment = 20;
            _height = new NumericUpDown();
            _height.Minimum = 400;
            _height.Maximum = 1200;
            _height.Increment = 20;
            TableLayoutPanel sizeRow = new TableLayoutPanel();
            sizeRow.Dock = DockStyle.Top;
            sizeRow.AutoSize = true;
            sizeRow.ColumnCount = 2;
            sizeRow.RowCount = 1;
            sizeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            sizeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            _width.Dock = DockStyle.Fill;
            _height.Dock = DockStyle.Fill;
            _width.Margin = new Padding(0, 0, 6, 0);
            _height.Margin = new Padding(6, 0, 0, 0);
            sizeRow.Controls.Add(_width, 0, 0);
            sizeRow.Controls.Add(_height, 1, 0);
            AddRow(table, "窗口尺寸", sizeRow, "网页版小窗的宽 × 高（像素）");

            _topMost = new CheckBox();
            _topMost.Text = "窗口置顶";
            _topMost.AutoSize = true;
            _topMost.ForeColor = Ink;
            AddRow(table, "置顶", _topMost, null);

            _bubbleWidth = new NumericUpDown();
            _bubbleWidth.Minimum = 300;
            _bubbleWidth.Maximum = 900;
            _bubbleWidth.Increment = 20;
            _bubbleHeight = new NumericUpDown();
            _bubbleHeight.Minimum = 240;
            _bubbleHeight.Maximum = 1000;
            _bubbleHeight.Increment = 40;
            TableLayoutPanel bubbleRow = new TableLayoutPanel();
            bubbleRow.Dock = DockStyle.Top;
            bubbleRow.AutoSize = true;
            bubbleRow.ColumnCount = 2;
            bubbleRow.RowCount = 1;
            bubbleRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            bubbleRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            _bubbleWidth.Dock = DockStyle.Fill;
            _bubbleHeight.Dock = DockStyle.Fill;
            _bubbleWidth.Margin = new Padding(0, 0, 6, 0);
            _bubbleHeight.Margin = new Padding(6, 0, 0, 0);
            bubbleRow.Controls.Add(_bubbleWidth, 0, 0);
            bubbleRow.Controls.Add(_bubbleHeight, 1, 0);
            AddRow(table, "气泡尺寸", bubbleRow, "宽 × 最大高度；回答越长越高，到上限就滚动");

            _showBubble = new CheckBox();
            _showBubble.Text = "气泡贴着鼠标出现（不勾选则屏幕居中）";
            _showBubble.AutoSize = true;
            _showBubble.ForeColor = Ink;
            AddRow(table, "气泡位置", _showBubble, null);

            _edgePath = new TextBox();
            AddRow(table, "Edge 路径", _edgePath, "留空自动查找 msedge.exe");

            _profileDir = new TextBox();
            AddRow(table, "登录数据目录", _profileDir, "留空则为 %AppData%\\BubbleAsk\\edge-profile");

            _cdpPort = new NumericUpDown();
            _cdpPort.Minimum = 1024;
            _cdpPort.Maximum = 65535;
            AddRow(table, "调试端口", _cdpPort, "只用本机 127.0.0.1，别和别的调试端口撞");

            Panel page = new Panel();
            page.Controls.Add(table);
            return page;
        }

        private Panel BuildHotkeyPage()
        {
            TableLayoutPanel table = NewTable();
            _hotkeySummon = new TextBox();
            AddRow(table, "唤起窗口", _hotkeySummon, "例如 Ctrl+Alt+D");
            _hotkeyAsk = new TextBox();
            AddRow(table, "抓词提问", _hotkeyAsk, "选中文字后按它，直接抓取并提问");
            _hotkeyShot = new TextBox();
            AddRow(table, "截图提问", _hotkeyShot, "拖框截图后连图带问题一起发");

            Label tip = new Label();
            tip.AutoSize = true;
            tip.MaximumSize = new Size(520, 0);
            tip.ForeColor = Muted;
            tip.Font = new Font("Microsoft YaHei UI", 8.5f);
            tip.Text = "写法：Ctrl / Alt / Shift / Win 加一个主键，例如 Ctrl+Shift+F2。\r\n" +
                       "组合被别的程序占用时，启动日志里会写「热键被占用」，换一个即可。";
            tip.Margin = new Padding(0, 18, 0, 0);
            table.RowCount = table.RowCount + 1;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(tip, 0, table.RowCount - 1);
            table.SetColumnSpan(tip, 2);

            Panel page = new Panel();
            page.Controls.Add(table);
            return page;
        }

        private Panel BuildApiPage()
        {
            TableLayoutPanel table = NewTable();
            _provider = new ComboBox();
            _provider.DropDownStyle = ComboBoxStyle.DropDownList;
            string[] names = ApiProviders.DisplayNames();
            for (int i = 0; i < names.Length; i++)
            {
                _provider.Items.Add(names[i]);
            }
            _provider.SelectedIndexChanged += delegate { ApplyProviderPreset(); };
            AddRow(table, "服务方", _provider, "选预设会填好地址和模型；自定义则自己填");

            _apiBase = new TextBox();
            AddRow(table, "接口地址", _apiBase, "OpenAI 兼容，例如 https://api.deepseek.com");
            _apiKey = new TextBox();
            _apiKey.UseSystemPasswordChar = true;
            AddRow(table, "API Key", _apiKey, "只保存在本机 config.json");
            _apiModel = new TextBox();
            AddRow(table, "模型", _apiModel, "例如 deepseek-chat");
            _apiMaxTokens = new NumericUpDown();
            _apiMaxTokens.Minimum = 128;
            _apiMaxTokens.Maximum = 32000;
            _apiMaxTokens.Increment = 128;
            AddRow(table, "最大输出", _apiMaxTokens, "单次回答的 token 上限");
            _systemPrompt = new TextBox();
            _systemPrompt.Multiline = true;
            _systemPrompt.Height = 76;
            _systemPrompt.ScrollBars = ScrollBars.Vertical;
            AddRow(table, "系统提示词", _systemPrompt, "每轮对话开头都会带上，用来约束回答风格");

            Panel page = new Panel();
            page.Controls.Add(table);
            return page;
        }

        private static TableLayoutPanel NewTable()
        {
            TableLayoutPanel table = new TableLayoutPanel();
            table.Dock = DockStyle.Top;
            table.AutoSize = true;
            table.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            table.ColumnCount = 2;
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 108f));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            table.RowCount = 0;
            table.Padding = new Padding(0);
            return table;
        }

        private static void AddRow(TableLayoutPanel table, string label, Control control, string hint)
        {
            int row = table.RowCount;
            table.RowCount = row + 1;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            Label caption = new Label();
            caption.Text = label;
            caption.AutoSize = true;
            caption.ForeColor = Muted;
            caption.TextAlign = ContentAlignment.MiddleLeft;
            caption.Margin = new Padding(0, 11, 12, 10);
            table.Controls.Add(caption, 0, row);

            if (hint == null)
            {
                if (control is CheckBox)
                {
                    control.Anchor = AnchorStyles.Left;
                }
                else
                {
                    control.Anchor = AnchorStyles.Left | AnchorStyles.Right;
                }
                control.Margin = new Padding(0, 8, 0, 8);
                table.Controls.Add(control, 1, row);
                return;
            }

            TableLayoutPanel cell = new TableLayoutPanel();
            cell.Dock = DockStyle.Top;
            cell.AutoSize = true;
            cell.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            cell.ColumnCount = 1;
            cell.RowCount = 2;
            cell.Margin = new Padding(0, 5, 0, 5);
            cell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            cell.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            control.Dock = DockStyle.Top;
            control.Margin = new Padding(0, 2, 0, 0);

            Label note = new Label();
            note.Text = hint;
            note.AutoSize = true;
            note.ForeColor = Muted;
            note.Font = new Font("Microsoft YaHei UI", 8.5f);
            note.Dock = DockStyle.Top;
            note.Margin = new Padding(0, 3, 0, 2);

            cell.Controls.Add(control, 0, 0);
            cell.Controls.Add(note, 0, 1);
            table.Controls.Add(cell, 1, row);
        }

        private void LoadValues()
        {
            _template.Text = _config.PromptTemplate;
            _mode.SelectedIndex = string.Equals(_config.Mode, "api", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
            _shotPrompt.Text = _config.ShotPrompt;
            _autoSend.Checked = _config.AutoSend;
            _autoStart.Checked = AutoStart.IsEnabled();
            _maxChars.Value = Clamp(_config.MaxChars, _maxChars);

            _chatUrl.Text = _config.ChatUrl;
            _width.Value = Clamp(_config.WindowWidth, _width);
            _height.Value = Clamp(_config.WindowHeight, _height);
            _topMost.Checked = _config.TopMost;
            _bubbleWidth.Value = Clamp(_config.BubbleWidth, _bubbleWidth);
            _bubbleHeight.Value = Clamp(_config.BubbleMaxHeight, _bubbleHeight);
            _showBubble.Checked = _config.ShowBubble;
            _edgePath.Text = _config.EdgePath;
            _profileDir.Text = _config.ProfileDir;
            _cdpPort.Value = Clamp(_config.CdpPort, _cdpPort);

            _hotkeySummon.Text = _config.HotkeySummon;
            _hotkeyAsk.Text = _config.HotkeyAsk;
            _hotkeyShot.Text = _config.HotkeyShot;

            _provider.SelectedIndex = ApiProviders.IndexOf(_config.ApiProvider);
            _apiBase.Text = _config.ApiBaseUrl;
            _apiKey.Text = _config.ApiKey;
            _apiModel.Text = _config.ApiModel;
            _apiMaxTokens.Value = Clamp(_config.ApiMaxTokens, _apiMaxTokens);
            _systemPrompt.Text = _config.ApiSystemPrompt;
        }

        private void ApplyProviderPreset()
        {
            int index = _provider.SelectedIndex;
            if (index < 0 || index >= ApiProviders.All.Count)
            {
                return;
            }
            ApiProvider provider = ApiProviders.All[index];
            if (provider.Id == ApiProviders.CustomId)
            {
                return;
            }
            _apiBase.Text = provider.BaseUrl;
            _apiModel.Text = provider.Model;
        }

        private static decimal Clamp(int value, NumericUpDown box)
        {
            if (value < box.Minimum)
            {
                return box.Minimum;
            }
            if (value > box.Maximum)
            {
                return box.Maximum;
            }
            return value;
        }

        private void SaveAndClose()
        {
            uint modifiers;
            uint key;
            if (!HotkeyManager.TryParse(_hotkeySummon.Text, out modifiers, out key))
            {
                _status.Text = "唤起窗口的热键格式不对";
                ShowPage(2);
                return;
            }
            if (!HotkeyManager.TryParse(_hotkeyAsk.Text, out modifiers, out key))
            {
                _status.Text = "抓词提问的热键格式不对";
                ShowPage(2);
                return;
            }
            if (!HotkeyManager.TryParse(_hotkeyShot.Text, out modifiers, out key))
            {
                _status.Text = "截图提问的热键格式不对";
                ShowPage(2);
                return;
            }

            _config.PromptTemplate = _template.Text.Trim();
            if (_config.PromptTemplate.Length == 0)
            {
                _config.PromptTemplate = PromptBuilder.DefaultTemplate;
            }
            _config.AutoSend = _autoSend.Checked;
            _config.MaxChars = (int)_maxChars.Value;
            _config.Mode = ComboId(_mode, "web");
            _config.ShotPrompt = _shotPrompt.Text.Trim();
            if (_config.ShotPrompt.Length == 0)
            {
                _config.ShotPrompt = PromptBuilder.DefaultShotPrompt;
            }
            _config.StartWithWindows = _autoStart.Checked;
            AutoStart.SetEnabled(_config.StartWithWindows);

            _config.ChatUrl = _chatUrl.Text.Trim();
            _config.WindowWidth = (int)_width.Value;
            _config.WindowHeight = (int)_height.Value;
            _config.TopMost = _topMost.Checked;
            _config.BubbleWidth = (int)_bubbleWidth.Value;
            _config.BubbleMaxHeight = (int)_bubbleHeight.Value;
            _config.ShowBubble = _showBubble.Checked;
            _config.EdgePath = _edgePath.Text.Trim();
            _config.ProfileDir = _profileDir.Text.Trim();
            _config.CdpPort = (int)_cdpPort.Value;

            _config.HotkeySummon = _hotkeySummon.Text.Trim();
            _config.HotkeyAsk = _hotkeyAsk.Text.Trim();
            _config.HotkeyShot = _hotkeyShot.Text.Trim();

            int providerIndex = _provider.SelectedIndex;
            if (providerIndex >= 0 && providerIndex < ApiProviders.All.Count)
            {
                _config.ApiProvider = ApiProviders.All[providerIndex].Id;
            }
            _config.ApiBaseUrl = _apiBase.Text.Trim();
            _config.ApiKey = _apiKey.Text.Trim();
            _config.ApiModel = _apiModel.Text.Trim();
            _config.ApiMaxTokens = (int)_apiMaxTokens.Value;
            _config.ApiSystemPrompt = _systemPrompt.Text.Trim();

            DialogResult = DialogResult.OK;
            Close();
        }

        private static string ComboId(ComboBox box, string fallback)
        {
            ComboItem item = box.SelectedItem as ComboItem;
            return item == null ? fallback : item.Id;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // 打开时别让模板框里的文字整段高亮，看着像被选中了。
            _template.SelectionStart = 0;
            _template.SelectionLength = 0;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_navFont != null)
                {
                    _navFont.Dispose();
                }
                if (_navFontBold != null)
                {
                    _navFontBold.Dispose();
                }
                if (_windowIcon != null)
                {
                    _windowIcon.Dispose();
                }
            }
            base.Dispose(disposing);
        }
    }

    /// <summary>下拉框里带 id 的选项。</summary>
    internal class ComboItem
    {
        public readonly string Id;
        public readonly string Label;

        public ComboItem(string id, string label)
        {
            Id = id;
            Label = label;
        }

        public override string ToString()
        {
            return Label;
        }
    }
}
