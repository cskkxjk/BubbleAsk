using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>托盘应用主体：热键分发、菜单、设置。</summary>
    public class TrayContext : ApplicationContext
    {
        private readonly AppConfig _config;
        private readonly ChatDriver _driver;
        private readonly ApiChat _api;
        private HotkeyManager _hotkeys;
        private readonly NotifyIcon _tray;
        private readonly Icon _icon;
        private SettingsForm _settingsForm;
        private bool _busy;

        public TrayContext(AppConfig config)
        {
            _config = config;
            _driver = new ChatDriver(config);
            _api = new ApiChat(config);

            _icon = IconFactory.Create(32);
            _tray = new NotifyIcon();
            _tray.Icon = _icon;
            _tray.Text = "Bubble Ask";
            _tray.Visible = true;
            _tray.DoubleClick += delegate { ShowSettings(); };
            _tray.ContextMenuStrip = BuildMenu();

            RebindHotkeys();
            _tray.ShowBalloonTip(2500, "Bubble Ask 已启动",
                _config.HotkeyAsk + " 抓词提问；" + _config.HotkeyShot + " 截图提问；" + _config.HotkeySummon + " 唤起/收起。",
                ToolTipIcon.Info);
            Log.Info("托盘已就绪");
        }

        private ContextMenuStrip BuildMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Font = new Font("Microsoft YaHei UI", 9f);
            menu.ShowImageMargin = false;
            menu.Renderer = new FlatMenuRenderer();
            menu.Items.Add(new ToolStripMenuItem("设置…", null, delegate { ShowSettings(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("打开对话窗口  (" + _config.HotkeySummon + ")", null,
                delegate { OpenChat(); }));
            menu.Items.Add(new ToolStripMenuItem("对选中文字提问  (" + _config.HotkeyAsk + ")", null,
                delegate { AskSelection(); }));
            menu.Items.Add(new ToolStripMenuItem("截图提问  (" + _config.HotkeyShot + ")", null,
                delegate { AskScreenshot(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("重启 Edge 会话", null, delegate { RestartSession(); }));
            menu.Items.Add(new ToolStripMenuItem("打开日志", null, delegate { OpenLog(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("退出", null, delegate { ExitApp(); }));
            return menu;
        }

        private void RebindHotkeys()
        {
            if (_hotkeys != null)
            {
                _hotkeys.Dispose();
            }
            _hotkeys = new HotkeyManager();
            _hotkeys.Pressed += OnHotkey;
            List<string> blocked = new List<string>();
            if (!_hotkeys.Register(_config.HotkeySummon, "summon"))
            {
                blocked.Add(_config.HotkeySummon);
            }
            if (!_hotkeys.Register(_config.HotkeyAsk, "ask"))
            {
                blocked.Add(_config.HotkeyAsk);
            }
            if (!_hotkeys.Register(_config.HotkeyShot, "shot"))
            {
                blocked.Add(_config.HotkeyShot);
            }
            if (blocked.Count > 0)
            {
                string list = string.Join("、", blocked.ToArray());
                Log.Warn("这些热键被别的程序占用了: " + list);
                _tray.ShowBalloonTip(5000, "热键被占用",
                    list + " 已被别的程序占用，托盘双击打开设置换一个。", ToolTipIcon.Warning);
            }
        }

        private void OnHotkey(string name)
        {
            // 截图遮罩是模态的，这期间再按热键会叠一层，直接忽略。
            if (_busy)
            {
                Log.Info("上一个操作还没结束，忽略热键: " + name);
                return;
            }
            Log.Info("热键触发: " + name);
            if (name == "summon")
            {
                OpenChat();
            }
            else if (name == "ask")
            {
                AskSelection();
            }
            else if (name == "shot")
            {
                AskScreenshot();
            }
        }

        private async void OpenChat()
        {
            if (IsApiMode())
            {
                bool closed = _api.ToggleBubble();
                if (closed)
                {
                    Log.Info("气泡已收起");
                }
                return;
            }
            try
            {
                bool closed = await _driver.ToggleAsync();
                if (closed)
                {
                    Log.Info("网页版窗口已收起");
                }
            }
            catch (Exception error)
            {
                Log.Error("打开窗口异常", error);
                Balloon("打开失败", error.Message);
            }
        }

        private async void AskSelection()
        {
            _busy = true;
            try
            {
                string selected;
                try
                {
                    selected = ClipboardCapture.TryGetSelectedText(500);
                }
                catch (Exception error)
                {
                    Log.Error("抓取选中文字失败", error);
                    Balloon("抓取失败", "目标程序可能不支持复制，试试截图提问。");
                    return;
                }

                if (string.IsNullOrEmpty(selected))
                {
                    Balloon("没抓到文字", "先在目标程序里选中内容，再按 " + _config.HotkeyAsk + "。");
                    return;
                }

                string text = PromptBuilder.Normalize(selected, _config.MaxChars);
                string prompt = PromptBuilder.Build(_config.PromptTemplate, text);
                Log.Info("提问: " + prompt);

                if (IsApiMode())
                {
                    _api.Ask(prompt, null);
                    return;
                }

                try
                {
                    bool ok = await _driver.AskAsync(prompt);
                    if (!ok)
                    {
                        Balloon("发送失败", "窗口已打开，但没有自动发送；日志里有原因。");
                    }
                }
                catch (Exception error)
                {
                    Log.Error("提问异常", error);
                    Balloon("发送失败", error.Message);
                }
            }
            finally
            {
                _busy = false;
            }
        }

        private async void AskScreenshot()
        {
            _busy = true;
            try
            {
                string path;
                try
                {
                    path = ScreenCapture.CaptureInteractive();
                }
                catch (Exception error)
                {
                    Log.Error("截图异常", error);
                    Balloon("截图失败", error.Message);
                    return;
                }

                if (string.IsNullOrEmpty(path))
                {
                    Log.Info("截图已取消");
                    return;
                }

                string prompt = PromptBuilder.BuildFree(_config.ShotPrompt);
                Log.Info("截图提问: " + path + " / " + prompt);

                if (IsApiMode())
                {
                    // 图片由后台请求读取，这里不能删；临时文件在下次启动时统一清理。
                    _api.Ask(prompt, path);
                    return;
                }

                try
                {
                    bool ok = await _driver.AskWithImageAsync(path, prompt);
                    if (!ok)
                    {
                        Balloon("截图发送失败", "窗口已打开，但图文没有发出去；日志里有原因。");
                    }
                }
                catch (Exception error)
                {
                    Log.Error("图文提问异常", error);
                    Balloon("截图发送失败", error.Message);
                }
                finally
                {
                    TryDelete(path);
                }
            }
            finally
            {
                _busy = false;
            }
        }

        private bool IsApiMode()
        {
            return string.Equals(_config.Mode, "api", StringComparison.OrdinalIgnoreCase);
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
            }
        }

        private void ShowSettings()
        {
            if (_settingsForm != null && !_settingsForm.IsDisposed)
            {
                _settingsForm.Activate();
                return;
            }
            _settingsForm = new SettingsForm(_config);
            DialogResult result = _settingsForm.ShowDialog();
            if (result == DialogResult.OK)
            {
                _config.Save();
                RebindHotkeys();
                _driver.Edge.ApplyTopMost();
                Balloon("设置已保存", "新的热键和配置已经生效。");
            }
            _settingsForm = null;
        }

        private void RestartSession()
        {
            try
            {
                _driver.Dispose();
                _driver.Edge.Stop();
                Balloon("会话已重启", "下次提问会重新拉起 Edge。");
            }
            catch (Exception error)
            {
                Log.Error("重启会话失败", error);
            }
        }

        private void OpenLog()
        {
            try
            {
                Process.Start(new ProcessStartInfo(Log.FilePath) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                Balloon("打开日志失败", error.Message);
            }
        }

        private void Balloon(string title, string text)
        {
            _tray.BalloonTipTitle = title;
            _tray.BalloonTipText = text;
            _tray.BalloonTipIcon = ToolTipIcon.Info;
            _tray.ShowBalloonTip(2500);
        }

        private void ExitApp()
        {
            try
            {
                _tray.Visible = false;
                _tray.Dispose();
                if (_hotkeys != null)
                {
                    _hotkeys.Dispose();
                }
                _driver.Dispose();
                _api.Dispose();
                _icon.Dispose();
            }
            catch
            {
            }
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_tray != null)
                {
                    _tray.Visible = false;
                    _tray.Dispose();
                }
                if (_hotkeys != null)
                {
                    _hotkeys.Dispose();
                }
                if (_driver != null)
                {
                    _driver.Dispose();
                }
                if (_api != null)
                {
                    _api.Dispose();
                }
                if (_icon != null)
                {
                    _icon.Dispose();
                }
            }
            base.Dispose(disposing);
        }
    }
}
