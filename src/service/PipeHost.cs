using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>
    /// 服务端宿主：持有唯一一份 <see cref="ChatDriver"/>，把管道请求翻译成驱动调用。
    ///
    /// 之前这段逻辑在 <c>TrayContext</c> 里（托盘既当 UI 又当引擎）。拆开之后
    /// 引擎只存在于服务进程，托盘与 DSH 插件都只是客户端 ——
    /// 两个所有者抢同一个 profile / CDP 端口的问题从根上消失。
    /// </summary>
    public class PipeHost : IIpcHost, IDisposable
    {
        private readonly AppConfig _config;
        private readonly ChatDriver _driver;
        private readonly object _gate = new object();
        private bool _busy;
        private DateTime _busySince;
        private bool _disposed;

        /// <summary>一次操作最多占用这么久；超时强制解除，避免服务永久卡在忙状态。</summary>
        private const int BusyTimeoutSeconds = 90;

        public PipeHost(AppConfig config)
        {
            _config = config;
            _driver = new ChatDriver(config);
        }

        /// <summary>启动时记一条浏览器信息，便于排查"网页版起不来"。</summary>
        public void LogBrowser()
        {
            try
            {
                BrowserInfo browser = _driver.Edge.Browser;
                if (browser == null)
                {
                    Log.Warn("没有检测到可用的浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），网页版会启动失败");
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

        //#region IIpcHost

        public bool TryBegin(string what)
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

        public void End()
        {
            lock (_gate)
            {
                _busy = false;
            }
        }

        public async Task<bool> SendAsync(string prompt, string providerId, string providerUrl)
        {
            return await _driver.AskAsync(prompt, ResolveProvider(providerId, providerUrl));
        }

        public async Task<bool> SendImageAsync(string imagePath, string prompt, string providerId, string providerUrl)
        {
            return await _driver.AskWithImageAsync(imagePath, prompt, ResolveProvider(providerId, providerUrl));
        }

        public async Task<bool> ToggleAsync(string providerId, string providerUrl)
        {
            return await _driver.ToggleAsync(ResolveProvider(providerId, providerUrl));
        }

        /// <summary>
        /// 把 IPC 请求里的 provider 字段解析成实际服务方。
        /// 不传 → 本机配置的默认服务方（旧版 DSH 插件 2.1.1 不传字段，行为与升级前一致：
        /// 仍按 config.WebProvider / ChatUrl 的入口发送；新版插件总是显式带 provider）。
        /// custom 的地址优先用请求里带的 providerUrl（服务端配置可能滞后），否则用本机配置的 ChatUrl。
        /// </summary>
        private WebProvider ResolveProvider(string providerId, string providerUrl)
        {
            if (string.IsNullOrEmpty(providerId))
            {
                return WebProviders.FromConfig(_config);
            }
            string url = providerUrl;
            if (string.IsNullOrEmpty(url))
            {
                url = _config.ChatUrl;
            }
            return WebProviders.Resolve(providerId, url);
        }

        public void ApplyTopMost()
        {
            try
            {
                _driver.Edge.ApplyTopMost();
            }
            catch (Exception error)
            {
                Log.Warn("应用窗口置顶失败: " + error.Message);
            }
        }

        public void Restart()
        {
            try
            {
                _driver.Dispose();
                _driver.Edge.Stop();
                Log.Info("会话已重启，下次操作会重新拉起浏览器");
            }
            catch (Exception error)
            {
                Log.Error("重启会话失败", error);
            }
        }

        public string LastStatus
        {
            get { return _driver.LastStatus; }
        }

        /// <summary>最近一次操作实际使用的服务方 id（IPC 响应里回传给调用方）。</summary>
        public string LastProvider
        {
            get { return _driver.LastProvider; }
        }

        public Dictionary<string, object> Health()
        {
            Dictionary<string, object> health = new Dictionary<string, object>();
            try
            {
                health["running"] = _driver.Edge.IsRunning;
                health["profileDir"] = _driver.Edge.EffectiveProfileDir;
                BrowserInfo browser = _driver.Edge.Browser;
                health["browser"] = browser == null ? "" : browser.DisplayName;
                health["browserPath"] = browser == null ? "" : browser.ExePath;
            }
            catch (Exception error)
            {
                health["running"] = false;
                health["error"] = error.Message;
            }
            WebProvider current = _driver.CurrentProvider;
            health["apiMode"] = string.Equals(_config.Mode, "api", StringComparison.OrdinalIgnoreCase);
            health["mode"] = _config.Mode;
            health["autoSend"] = _config.AutoSend;
            health["cdpPort"] = _config.CdpPort;
            // 网页版服务方：当前生效的、配置里的默认值、以及支持的全部 id。
            health["currentProvider"] = current == null ? "" : current.Id;
            health["currentProviderName"] = current == null ? "" : current.Name;
            health["webProvider"] = WebProviders.NormalizeId(_config.WebProvider);
            health["providers"] = WebProviders.Ids();
            health["chatUrl"] = current == null ? _config.ChatUrl : current.Url;
            health["lastStatus"] = _driver.LastStatus ?? "";
            health["lastProvider"] = _driver.LastProvider ?? "";
            return health;
        }

        //#endregion

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            try
            {
                _driver.Dispose();
            }
            catch
            {
                // 释放失败不影响进程退出。
            }
        }
    }
}
