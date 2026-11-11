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
        /// <summary>网页版引擎在后台服务里；这里只是客户端。</summary>
        private readonly EngineClient _engine;
        private readonly ApiChat _api;
        private HotkeyManager _hotkeys;
        private readonly NotifyIcon _tray;
        private readonly Icon _icon;
        private SettingsForm _settingsForm;
        /// <summary>本地占用位：避免连点/热键重复触发，服务端还有一层自己的占用位。</summary>
        private readonly object _gate = new object();
        private bool _busy;
        private DateTime _busySince;

        /// <summary>一次操作最多占用这么久；超时强制解除，避免热键永久失效。</summary>
        private const int BusyTimeoutSeconds = 90;

        public TrayContext(AppConfig config)
        {
            _config = config;
            _engine = new EngineClient(config);
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

            // 引擎在后台服务里：确保它起来，并登记一条租约让服务知道托盘还活着。
            // 起不来不影响托盘与其他功能，只是网页版不可用。
            try
            {
                string error;
                if (_engine.EnsureRunning(out error))
                {
                    _engine.AttachLease();
                    Log.Info("后台服务已就绪: " + IpcContract.PipeName);
                }
                else
                {
                    Log.Warn("后台服务未就绪（网页版功能不可用）: " + error);
                }
            }
            catch (Exception error)
            {
                Log.Warn("连接后台服务失败: " + error.Message);
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
            menu.Items.Add(new ToolStripMenuItem("打开对话窗口 (" + _config.HotkeySummon + ")", null,
                delegate { OpenChat(); }));
            menu.Items.Add(new ToolStripMenuItem("对选中文字提问 (" + _config.HotkeyAsk + ")", null,
                delegate { AskSelection(); }));
            menu.Items.Add(new ToolStripMenuItem("截图提问 (" + _config.HotkeyShot + ")", null,
                delegate { AskScreenshot(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("重启浏览器会话", null, delegate { RestartSession(); }));
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
                    list + " 已被其它程序占用，双击托盘图标打开设置后更换。", ToolTipIcon.Warning);
            }
        }

        private void LogBrowser()
        {
            try
            {
                Dictionary<string, object> health = _engine.Health();
                if (!Json.GetBool(health, "ok", false))
                {
                    Log.Warn("后台服务未就绪，浏览器信息由服务在启动时记录");
                    return;
                }
                string browser = Json.GetString(health, "browser", "");
                if (string.IsNullOrEmpty(browser))
                {
                    Log.Warn("服务报告没有可用的浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），网页版会启动失败");
                    Balloon("找不到浏览器", "没有检测到 Edge / Chrome 等 Chromium 内核浏览器，请在设置里指定浏览器路径。");
                    return;
                }
                Log.Info("服务使用的浏览器: " + browser + "，profile: " + Json.GetString(health, "profileDir", ""));
                Log.Info("网页版服务方: " + Json.GetString(health, "currentProviderName", "")
                    + "（" + Json.GetString(health, "currentProvider", "") + "）");
            }
            catch (Exception error)
            {
                Log.Warn("查询服务状态失败: " + error.Message);
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
                    bool closed = await _engine.ToggleAsync(_config.WebProvider, CustomUrlOrNull());
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
                    Balloon("抓取失败", "目标程序可能不支持复制，请改用截图提问。");
                    return;
                }

                if (string.IsNullOrEmpty(selected))
                {
                    Balloon("没抓到文字", "先在目标程序里选中内容，再按 " + _config.HotkeyAsk + "。");
                    return;
                }

                string text = PromptBuilder.Normalize(selected, _config.MaxChars);
                // 先问一句「你想问什么」：留空 ＝ 老模板，取消 ＝ 什么都不发。
                // 只传选中文字给弹窗，不让它把 clipboard 里的原文改坏。
                string question = QuestionForm.Ask(text, _config.PromptTemplate);
                if (question == null)
                {
                    Log.Info("抓词提问已取消");
                    return;
                }
                string prompt = PromptBuilder.BuildWithQuestion(question, text);
                if (prompt.Length == 0)
                {
                    prompt = PromptBuilder.Build(_config.PromptTemplate, text);
                }
                Log.Info("提问: " + prompt);

                if (IsApiMode())
                {
                    _api.Ask(prompt, null);
                    return;
                }

                try
                {
                    bool ok = await _engine.AskAsync(prompt, _config.WebProvider, CustomUrlOrNull());
                    if (!ok)
                    {
                        Balloon("没能自动发送",
                            "窗口已打开。问题可能已填入输入框，也可能没有；请确认后手动按回车。详细原因见日志。");
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
                    bool ok = await _engine.AskWithImageAsync(path, prompt, _config.WebProvider, CustomUrlOrNull());
                    if (!ok)
                    {
                        Balloon("截图没能自动发出",
                            "窗口已打开。图片可能已粘贴到输入框，也可能没有；请确认后手动按回车。详细原因见日志。");
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

        /// <summary>
        /// 「自定义」服务方的地址要随请求带给服务端（服务端进程里的配置可能还没重载，见 HANDOVER 已知项）；
        /// 预设服务方的入口地址由服务端按 id 解析，返回 null 即可。
        /// 这样设置页切服务方后，下一次热键立即生效，不依赖服务端重读配置。
        /// </summary>
        private string CustomUrlOrNull()
        {
            if (string.Equals(_config.WebProvider, WebProviders.CustomId, StringComparison.OrdinalIgnoreCase))
            {
                return _config.ChatUrl;
            }
            return null;
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
                    _engine.ApplyTopMost();
                    // 服务端进程里的配置只在启动时读一次，切换服务方靠 IPC 的 provider 字段即时生效；
                    // 这里记一行日志，排查「设置改了没生效」时能看到当时的配置值。
                    WebProvider selected = WebProviders.FromConfig(_config);
                    Log.Info("设置已保存：网页版服务方=" + selected.Id + "（" + selected.Name + "），地址=" + selected.Url);
                    // 窗口尺寸/调试端口/浏览器 这些要等下次拉起浏览器才生效，别一律说"已生效"。
                    Balloon("设置已保存", "热键立即生效。网页版服务方在下一次打开网页窗口时切换。窗口尺寸、调试端口与浏览器的改动在下次启动浏览器时生效。");
                }
            }
            _settingsForm = null;
        }

        private void RestartSession()
        {
            try
            {
                _engine.Restart();
                Balloon("会话已重启", "下次提问会重新拉起浏览器。");
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
                _engine.Dispose();
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
                if (_engine != null)
                {
                    _engine.Dispose();
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
