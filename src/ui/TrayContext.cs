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
    public class TrayContext : ApplicationContext, IIpcHost
    {
        private readonly AppConfig _config;
        private readonly ChatDriver _driver;
        private readonly ApiChat _api;
        private HotkeyManager _hotkeys;
        private readonly NotifyIcon _tray;
        private readonly Icon _icon;
        private SettingsForm _settingsForm;
        private PipeServer _ipc;
        /// <summary>管道线程与界面线程都会碰 _busy，统一用它串行化。</summary>
        private readonly object _gate = new object();
        private bool _busy;
        private DateTime _busySince;

        /// <summary>一次操作最多占用这么久；超时强制解除，避免热键永久失效。</summary>
        private const int BusyTimeoutSeconds = 90;

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
            LogBrowser();
            _tray.ShowBalloonTip(2500, "Bubble Ask 已启动",
                _config.HotkeyAsk + " 抓词提问；" + _config.HotkeyShot + " 截图提问；" + _config.HotkeySummon + " 唤起/收起。",
                ToolTipIcon.Info);
            Log.Info("托盘已就绪");

            // 管道服务：让 DSH 插件复用同一套登录 profile 与 CDP 驱动。
            // 起不来不该影响托盘本身，所以整体包一层。
            try
            {
                _ipc = new PipeServer(this);
                _ipc.Start();
                PipeServer.WriteDiscovery(Application.ExecutablePath);
                Log.Info("DSH 插件可经管道调用: " + PipeServer.PipeName);
            }
            catch (Exception error)
            {
                Log.Warn("管道服务启动失败（插件将无法调用本应用）: " + error.Message);
            }
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

        private void LogBrowser()
        {
            try
            {
                BrowserInfo browser = _driver.Edge.Browser;
                if (browser == null)
                {
                    Log.Warn("没有检测到可用的浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），网页版会启动失败");
                    Balloon("找不到浏览器", "没有检测到 Edge / Chrome 等 Chromium 内核浏览器，请在设置里指定浏览器路径。");
                    return;
                }
                Log.Info("使用的浏览器: " + browser.DisplayName + " " + browser.Version + " (" + browser.ExePath
                         + ")，profile: " + _driver.Edge.EffectiveProfileDir);
            }
            catch (Exception error)
            {
                Log.Warn("检测浏览器失败: " + error.Message);
            }
        }

        private void OnHotkey(string name)
        {
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

        /// <summary>
        /// 抢占用。托盘菜单项也走这里，否则提问进行中再点菜单会并发进同一套 CDP 连接。
        /// 另外带一个看门狗：万一某次操作真的卡死（网络/浏览器没响应），
        /// 超过 BusyTimeoutSeconds 就强制解除，别让三个热键一起哑掉。
        /// </summary>
        private bool TryBeginOperation(string what)
        {
            lock (_gate)
            {
                if (_busy)
                {
                    double elapsed = (DateTime.UtcNow - _busySince).TotalSeconds;
                    if (elapsed < BusyTimeoutSeconds)
                    {
                        Log.Info("上一个操作还没结束（" + (int)elapsed + " 秒），忽略: " + what);
                        return false;
                    }
                    Log.Warn("上一个操作卡了 " + (int)elapsed + " 秒，强制解除占用后继续: " + what);
                }
                _busy = true;
                _busySince = DateTime.UtcNow;
                return true;
            }
        }

        private void EndOperation()
        {
            lock (_gate)
            {
                _busy = false;
            }
        }

        //#region IIpcHost —— 供 DSH 插件通过本地管道复用本应用的登录态与 CDP 驱动

        bool IIpcHost.TryBegin(string what)
        {
            return TryBeginOperation(what);
        }

        void IIpcHost.End()
        {
            EndOperation();
        }

        async Task<bool> IIpcHost.SendAsync(string prompt)
        {
            return await _driver.AskAsync(prompt);
        }

        async Task<bool> IIpcHost.OpenAsync()
        {
            return await _driver.OpenAsync();
        }

        string IIpcHost.LastStatus
        {
            get { return _driver.LastStatus; }
        }

        Dictionary<string, object> IIpcHost.Health()
        {
            Dictionary<string, object> health = new Dictionary<string, object>();
            try
            {
                health["running"] = _driver.Edge.IsRunning;
                health["profileDir"] = _driver.Edge.EffectiveProfileDir;
            }
            catch (Exception error)
            {
                health["running"] = false;
                health["error"] = error.Message;
            }
            health["apiMode"] = IsApiMode();
            health["mode"] = _config.Mode;
            health["autoSend"] = _config.AutoSend;
            health["cdpPort"] = _config.CdpPort;
            health["chatUrl"] = _config.ChatUrl;
            return health;
        }

        //#endregion

        private async void OpenChat()
        {
            if (!TryBeginOperation("唤起/收起窗口"))
            {
                return;
            }
            try
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
            finally
            {
                EndOperation();
            }
        }

        private async void AskSelection()
        {
            if (!TryBeginOperation("抓词提问"))
            {
                return;
            }
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
                        Balloon("没能自动发送",
                            "窗口已打开：问题可能已填进输入框（也可能没有），请看一眼并手动按回车；详细原因在日志里。");
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
                EndOperation();
            }
        }

        private async void AskScreenshot()
        {
            if (!TryBeginOperation("截图提问"))
            {
                return;
            }
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
                        Balloon("截图没能自动发出",
                            "窗口已打开：图片可能已贴上（也可能没有），请看一眼并手动按回车；详细原因在日志里。");
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
                EndOperation();
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
            using (SettingsForm form = new SettingsForm(_config))
            {
                _settingsForm = form;
                DialogResult result = form.ShowDialog();
                if (result == DialogResult.OK)
                {
                    _config.Save();
                    RebindHotkeys();
                    _driver.Edge.ApplyTopMost();
                    // 窗口尺寸/调试端口/浏览器 这些要等下次拉起浏览器才生效，别一律说"已生效"。
                    Balloon("设置已保存", "热键立即生效；窗口尺寸、调试端口、浏览器改动会在下次打开网页窗口时生效。");
                }
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
                if (_ipc != null)
                {
                    _ipc.Dispose();
                    _ipc = null;
                }
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
                if (_ipc != null)
                {
                    _ipc.Dispose();
                    _ipc = null;
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
