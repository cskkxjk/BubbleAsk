using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>
    /// 把问题送进浏览器里的网页版聊天页面：优先 DOM 注入，失败退回 URL 预填。
    ///
    /// 站点差异（URL、输入框/发送按钮选择器、能否预填、要不要 Enter 兜底）全部来自
    /// <see cref="WebProvider"/>；窗口仍是单实例（同一个浏览器 app 窗口、同一个 profile），
    /// 换服务方时通过 CDP 导航到目标地址，登录 cookie 保留在 profile 里。
    /// </summary>
    public class ChatDriver : IDisposable
    {
        private readonly AppConfig _config;
        private readonly EdgeHost _edge;
        private CdpClient _cdp;
        private WebProvider _provider;

        public ChatDriver(AppConfig config)
        {
            _config = config;
            _edge = new EdgeHost(config);
            _provider = WebProviders.FromConfig(config);
        }

        public EdgeHost Edge
        {
            get { return _edge; }
        }

        /// <summary>当前使用的网页版服务方（最近一次操作传入/配置解析出来的）。</summary>
        public WebProvider CurrentProvider
        {
            get { return _provider == null ? WebProviders.DefaultProvider : _provider; }
        }

        /// <summary>当前服务方 id，供 IPC 响应带回给调用方。</summary>
        public string LastProvider
        {
            get { return CurrentProvider.Id; }
        }

        /// <summary>
        /// 最近一次 AskAsync 的阶段标签，供管道对端报告失败原因。
        /// 取值与插件原有词汇一致：sent / filled / prefilled / error 等（不拼接服务方，
        /// 服务方信息走 IPC 响应里的 provider 字段，避免破坏插件对 stage 的判断）。
        /// </summary>
        public string LastStatus { get; private set; }

        public void EnsureWindow()
        {
            _edge.ShowAndFocus();
        }

        public async Task<bool> AskAsync(string prompt, WebProvider provider)
        {
            LastStatus = "idle";
            if (string.IsNullOrEmpty(prompt))
            {
                LastStatus = "fill";
                return false;
            }
            for (int attempt = 0; attempt < 2; attempt++)
            {
                bool retry = false;
                try
                {
                    await EnsureConnectedAsync(provider);
                    EnsureWindow();
                    await WaitForComposerAsync(25000);
                    string filled = await FillWithRetryAsync(prompt);
                    Log.Info("[" + CurrentProvider.Id + "] 注入输入框结果: " + filled);
                    if (filled == "none")
                    {
                        Log.Warn("注入失败：页面上没找到输入框（composer）");
                        return await FallbackNavigateAsync(prompt);
                    }
                    if (filled == null || filled.StartsWith("failed", StringComparison.Ordinal))
                    {
                        Log.Warn("注入失败：文本没能写进输入框（" + filled + "），判定为未发送");
                        return await FallbackNavigateAsync(prompt);
                    }
                    if (!_config.AutoSend)
                    {
                        Log.Info("自动发送已关闭，只填入不发送");
                        LastStatus = "filled";
                        return true;
                    }
                    await Task.Delay(250);
                    string status = await SendAndVerifyAsync(true, 2000);
                    Log.Info("[" + CurrentProvider.Id + "] 发送校验结果: " + status);
                    if (status == "sent")
                    {
                        LastStatus = "sent";
                        return true;
                    }
                    if (NeedsPrefillFallback(status))
                    {
                        Log.Warn("发送没能触发（" + status + "），改走 URL 预填");
                        return await FallbackNavigateAsync(prompt);
                    }
                    // 已经点过发送但没能确认：别再导航（会丢掉当前会话，也可能其实已经发出去了），
                    // 保持页面原样让用户手动按 Enter。
                    Log.Warn("已点击发送但没能确认发出去（" + status + "），不导航，保持页面原样，请手动回车确认");
                    LastStatus = status;
                    return false;
                }
                catch (Exception error)
                {
                    Log.Error("发送失败（第 " + (attempt + 1) + " 次）", error);
                    LastStatus = "error";
                    Reset();
                    retry = true;
                }
                if (retry)
                {
                    await Task.Delay(400);
                }
            }
            if (string.IsNullOrEmpty(LastStatus) || LastStatus == "idle")
            {
                LastStatus = "error";
            }
            return false;
        }

        public async Task<bool> AskWithImageAsync(string imagePath, string prompt, WebProvider provider)
        {
            LastStatus = "idle";
            try
            {
                await EnsureConnectedAsync(provider);
                if (!provider.Upload)
                {
                    Log.Info("[" + CurrentProvider.Id + "] 该服务方未启用图片上传，退化为纯文本提问");
                    return await AskAsync(prompt, provider);
                }
                EnsureWindow();
                await WaitForComposerAsync(25000);

                // 首选：把文件直接塞进页面的 file input，不碰剪贴板、不要求窗口有焦点。
                bool attached = await AttachImageAsync(imagePath);
                if (!attached)
                {
                    Log.Warn("没找到上传入口，改用剪贴板粘贴");
                    attached = await PasteImageAsync(imagePath);
                }
                if (!attached)
                {
                    Log.Warn("图片没能送进页面，改为只发送文字");
                    return await AskAsync(prompt, provider);
                }

                await Task.Delay(700);

                if (!string.IsNullOrEmpty(prompt))
                {
                    string filled = await FillWithRetryAsync(prompt);
                    Log.Info("[" + CurrentProvider.Id + "] 截图后注入文本: " + filled);
                    if (filled == "none" || filled == null || filled.StartsWith("failed", StringComparison.Ordinal))
                    {
                        Log.Warn("图文：文本没能写进输入框（" + filled + "），判定为未发送");
                        LastStatus = "fill";
                        return false;
                    }
                    await Task.Delay(250);
                }

                if (!_config.AutoSend)
                {
                    Log.Info("自动发送已关闭，图文只贴上不发送");
                    LastStatus = "filled";
                    return true;
                }

                string status = await SendAndVerifyAsync(!string.IsNullOrEmpty(prompt), 2000);
                Log.Info("[" + CurrentProvider.Id + "] 图文发送校验结果: " + status);
                if (status == "sent")
                {
                    LastStatus = "sent";
                    return true;
                }
                LastStatus = status;
                Log.Warn("图文发送未确认成功（" + status + "），不当作成功");
                return false;
            }
            catch (Exception error)
            {
                Log.Error("图文发送失败", error);
                LastStatus = "error";
                Reset();
                return false;
            }
        }

        /// <summary>通过 CDP 往页面里的 file input 塞文件；找不到输入框就点一下上传按钮再找。</summary>
        private async Task<bool> AttachImageAsync(string imagePath)
        {
            try
            {
                string objectId = await _cdp.EvaluateHandleAsync(PageScripts.BuildFileInputScript(), 5000);
                if (string.IsNullOrEmpty(objectId))
                {
                    string opened = await _cdp.EvaluateAsync(PageScripts.BuildOpenUploadScript(), 4000);
                    Log.Info("打开上传入口: " + opened);
                    await Task.Delay(800);
                    objectId = await _cdp.EvaluateHandleAsync(PageScripts.BuildFileInputScript(), 5000);
                }
                if (string.IsNullOrEmpty(objectId))
                {
                    return false;
                }

                await _cdp.EnableDomAsync(4000);
                bool ok = await _cdp.SetFileInputFilesAsync(objectId, imagePath, 8000);
                if (ok)
                {
                    Log.Info("截图已交进文件输入框: " + imagePath);
                }
                return ok;
            }
            catch (Exception error)
            {
                Log.Warn("文件上传通道失败: " + error.Message);
                return false;
            }
        }

        /// <summary>退路：图片放剪贴板 + Ctrl+V。需要窗口在前台。</summary>
        private async Task<bool> PasteImageAsync(string imagePath)
        {
            if (!ClipboardCapture.TrySetImage(imagePath))
            {
                return false;
            }
            await _cdp.EvaluateAsync(PageScripts.BuildFocusScript(CurrentProvider), 5000);
            await Task.Delay(200);
            ClipboardCapture.SendPaste();
            Log.Info("已向页面粘贴截图");
            await Task.Delay(900);
            // 粘贴没有返回值，只能回读输入框里是否出现图片；否则会在没有附图的情况下继续发送并当作成功。
            ComposerState state = await ReadComposerAsync();
            if (state != null && state.HasImage)
            {
                return true;
            }
            Log.Warn("粘贴后输入框里没有出现图片，判定为未附图");
            return false;
        }

        public async Task<bool> OpenAsync(WebProvider provider)
        {
            try
            {
                await EnsureConnectedAsync(provider);
                EnsureWindow();
                await WaitForComposerAsync(10000);
                return true;
            }
            catch (Exception error)
            {
                Log.Error("打开会话失败", error);
                return false;
            }
        }

        /// <summary>
        /// 唤起/收起。已在前台就关掉，否则拉到前台；窗口不存在就启动。
        /// 若当前页面不是目标服务方，先 CDP 导航过去（同一个 app 窗口里换页面）。
        /// 返回值：true 表示这次是「关掉」。
        /// </summary>
        public async Task<bool> ToggleAsync(WebProvider provider)
        {
            if (_edge.IsVisible)
            {
                if (_edge.IsForeground)
                {
                    Log.Info("窗口已在前台，关掉它");
                    Reset();
                    _edge.CloseWindow();
                    return true;
                }
                if (_cdp == null || !_cdp.IsConnected || !provider.MatchesUrl(_cdp.TargetUrl))
                {
                    // 窗口开着但页面不是目标服务方：先切页面，再拉到前台。
                    await EnsureConnectedAsync(provider);
                }
                else
                {
                    _provider = provider;
                }
                Log.Info("窗口在，拉到前台");
                _edge.ShowAndFocus();
                return false;
            }
            await OpenAsync(provider);
            return false;
        }

        public async Task<string> GetStateAsync()
        {
            try
            {
                await EnsureConnectedAsync(_provider);
                return await _cdp.EvaluateAsync(PageScripts.BuildStateScript(CurrentProvider), 5000);
            }
            catch (Exception error)
            {
                return "ERR: " + error.Message;
            }
        }

        /// <summary>在页面里求值，返回字符串结果。排查页面结构时用。</summary>
        public async Task<string> EvaluateAsync(string script)
        {
            await EnsureConnectedAsync(_provider);
            return await _cdp.EvaluateAsync(script, 8000);
        }

        /// <summary>
        /// 连上（必要时先拉起浏览器）并确保当前页面就是目标服务方：
        /// 不在同一个站点时用 CDP 导航过去，登录态仍复用同一个浏览器 profile。
        /// </summary>
        private async Task EnsureConnectedAsync(WebProvider provider)
        {
            if (provider == null)
            {
                provider = WebProviders.DefaultProvider;
            }
            bool switched = _provider == null
                || !string.Equals(_provider.Id, provider.Id, StringComparison.OrdinalIgnoreCase);
            _provider = provider;
            if (_cdp != null && _cdp.IsConnected)
            {
                if (!provider.MatchesUrl(_cdp.TargetUrl))
                {
                    await NavigateToProviderAsync(provider);
                }
                WarnIfLoginPage(provider);
                return;
            }
            Reset();
            // 启动浏览器可能要等十几秒，放到后台线程，别冻住界面。
            WebProvider target = provider;
            await Task.Run(new Action(delegate { _edge.EnsureStarted(target.Url); }));
            _cdp = new CdpClient();
            await _cdp.ConnectAsync(_config.CdpPort, provider.PrimaryAuthority, 20000);
            if (!provider.MatchesUrl(_cdp.TargetUrl))
            {
                await NavigateToProviderAsync(provider);
            }
            else if (switched)
            {
                Log.Info("已连接网页版服务方: " + provider.Name);
            }
            WarnIfLoginPage(provider);
        }

        /// <summary>当前停在登录页时提示用户先登录（登录态会保存在浏览器 profile 里，只需一次）。</summary>
        private void WarnIfLoginPage(WebProvider provider)
        {
            if (_cdp == null || !provider.IsLoginUrl(_cdp.TargetUrl))
            {
                return;
            }
            Log.Warn("页面停在 " + provider.Name + " 的登录页（" + _cdp.TargetUrl
                + "），请先在窗口里登录一次；登录态保存在浏览器 profile 里，之后长期有效");
        }

        /// <summary>导航到服务方入口地址，并按 VerifyUrlRegex 记一条日志（只告警，不阻断流程）。</summary>
        private async Task NavigateToProviderAsync(WebProvider provider)
        {
            Log.Info("切换网页版服务方: " + provider.Name + "（" + provider.Url + "）");
            await _cdp.NavigateAsync(provider.Url, 10000);
            await Task.Delay(1200);
            if (string.IsNullOrEmpty(provider.VerifyUrlRegex))
            {
                return;
            }
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(_cdp.TargetUrl, provider.VerifyUrlRegex))
                {
                    Log.Warn("当前地址与 " + provider.Id + " 的预期不符: " + _cdp.TargetUrl);
                }
            }
            catch (Exception error)
            {
                Log.Warn("校验服务方地址失败: " + error.Message);
            }
        }

        /// <summary>
        /// 等输入框出现。冷启动（第一次拉起浏览器、刚登录完、SPA 还在加载）时页面可能要十几秒才画出来，
        /// 所以给足 25 秒，并记下当时页面的加载状态，超时后日志里能看出到底是慢还是结构变了。
        /// </summary>
        private async Task<bool> WaitForComposerAsync(int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                ComposerState state = await ReadComposerAsync();
                if (state != null && state.Found)
                {
                    if (waited > 3000)
                    {
                        Log.Info("输入框在 " + waited + " 毫秒后才出现（页面加载偏慢）");
                    }
                    return true;
                }
                await Task.Delay(300);
                waited += 300;
            }
            string page;
            try
            {
                page = await _cdp.EvaluateAsync(
                    "JSON.stringify({ready:document.readyState,url:location.href," +
                    "title:document.title,len:(document.body?document.body.innerText.length:-1)})", 5000);
            }
            catch (Exception error)
            {
                page = "读取页面状态失败: " + error.Message;
            }
            Log.Warn("等待输入框超时（" + timeoutMs + " 毫秒）。页面状态: " + page);
            return false;
        }

        /// <summary>
        /// 注入文本；没找到输入框时再等一小会儿重试一次（页面可能刚渲染完）。
        /// 返回 PageScripts.BuildFillScript 的原始结果（'textarea' / 'editable' / 'none' / 'failed:*'）。
        /// </summary>
        private async Task<string> FillWithRetryAsync(string prompt)
        {
            string filled = await _cdp.EvaluateAsync(PageScripts.BuildFillScript(CurrentProvider, prompt), 8000);
            if (filled != null && filled != "none")
            {
                return filled;
            }
            ComposerState state = await ReadComposerAsync();
            if (state != null && state.Found)
            {
                return filled;
            }
            Log.Warn("第一次注入没找到输入框，等 1.5 秒重试");
            await Task.Delay(1500);
            return await _cdp.EvaluateAsync(PageScripts.BuildFillScript(CurrentProvider, prompt), 8000);
        }

        /// <summary>
        /// 点发送按钮（或退回 CDP 可信 Enter），然后回读输入框是否真的被清空。
        /// 返回 'sent' 之外的任何值都代表「没能确认发出去」，调用方必须按失败处理。
        /// </summary>
        private async Task<string> SendAndVerifyAsync(bool expectContent, int verifyTimeoutMs)
        {
            ComposerState before = await ReadComposerAsync();
            Log.Info("发送前输入框: " + (before == null ? "读不到" : before.Describe()));
            if (before == null || !before.Found)
            {
                Log.Warn("发送前找不到输入框（composer），判定为失败");
                return "nobox";
            }
            if (expectContent && !before.HasText)
            {
                Log.Warn("要发送的文本没有留在输入框里，判定为失败: " + before.Describe());
                return "filllost";
            }

            string action = null;
            try
            {
                action = await _cdp.EvaluateAsync(PageScripts.BuildSendScript(CurrentProvider), 5000);
            }
            catch (Exception error)
            {
                Log.Warn("点击发送按钮异常: " + error.Message);
            }
            Log.Info("发送按钮回读: " + (action == null ? "null" : action));

            bool triggered = action != null && action.StartsWith("clicked", StringComparison.Ordinal);
            if (!triggered)
            {
                if (!CurrentProvider.EnterSends)
                {
                    Log.Warn("发送按钮不可用（" + (action == null ? "null" : action)
                        + "），且该服务方未启用 Enter 兜底，判定为未发送");
                    return "noaction";
                }
                Log.Warn("发送按钮不可用（" + (action == null ? "null" : action) + "），改用 CDP 可信 Enter");
                await FocusComposerAsync();
                triggered = await DispatchEnterAsync();
            }
            if (!triggered)
            {
                Log.Warn("点击发送按钮和可信 Enter 都没能发出动作");
                return "noaction";
            }

            string verdict = await WaitForSentAsync(before, verifyTimeoutMs);
            if (verdict == "sent")
            {
                return "sent";
            }
            Log.Warn("首次发送未通过回读校验（" + verdict + "），复查后再决定是否补发");

            // 先复查一次：可能只是页面慢，避免重复发送。
            bool stillThere = await ComposerStillHasContentAsync();
            if (!stillThere)
            {
                ComposerState late = await ReadComposerAsync();
                return ClassifyCleared(before, late);
            }

            await FocusComposerAsync();
            if (!CurrentProvider.EnterSends)
            {
                // 该站点没有启用 Enter 兜底：不能靠回车补发，直接把未确认状态交回去。
                return verdict;
            }
            bool enterOk = await DispatchEnterAsync();
            Log.Info("补发可信 Enter 结果: " + enterOk);
            if (!enterOk)
            {
                return verdict;
            }
            string second = await WaitForSentAsync(before, verifyTimeoutMs);
            Log.Info("补发后回读: " + second);
            return second;
        }

        /// <summary>轮询输入框状态，等它被清空。返回 'sent' 表示确认发出去了。</summary>
        private async Task<string> WaitForSentAsync(ComposerState before, int timeoutMs)
        {
            ComposerState last = null;
            int waited = 0;
            while (waited < timeoutMs)
            {
                last = await ReadComposerAsync();
                if (last != null && last.Found && last.IsEmpty)
                {
                    return ClassifyCleared(before, last);
                }
                await Task.Delay(120);
                waited += 120;
            }
            if (last == null || !last.Found)
            {
                return "nobox";
            }
            if (last.HasText && last.HasImage)
            {
                return "pending-text-image";
            }
            if (last.HasText)
            {
                return "pending-text";
            }
            if (last.HasImage)
            {
                return "pending-image";
            }
            return ClassifyCleared(before, last);
        }

        /// <summary>
        /// 输入框已经空了：发送前有内容 → 确实发出去了；
        /// 发送前本来就空（纯图片）→ 只能靠「发送按钮变灰」佐证，否则算未确认。
        /// 读不到输入框时一律算未确认，绝不能因为「读不到」就报成功。
        /// </summary>
        private static string ClassifyCleared(ComposerState before, ComposerState after)
        {
            if (after == null || !after.Found)
            {
                return "unverified";
            }
            if (!after.IsEmpty)
            {
                return "pending";
            }
            if (before != null && before.HasContent)
            {
                return "sent";
            }
            if (!after.SendEnabled)
            {
                return "sent";
            }
            return "unverified";
        }

        /// <summary>
        /// 只有「发送动作根本没触发」时才值得退到 ?q= 预填链接：
        /// 此时页面没被改动过，导航过去不会打断正在进行的会话。
        /// </summary>
        private static bool NeedsPrefillFallback(string status)
        {
            if (status == null)
            {
                return true;
            }
            if (status == "noaction" || status == "filllost" || status == "nobox")
            {
                return true;
            }
            return false;
        }

        private async Task<bool> ComposerStillHasContentAsync()
        {
            ComposerState state = await ReadComposerAsync();
            if (state == null || !state.Found)
            {
                return true; // 读不到就当还有内容，宁可再补一次也不谎报成功
            }
            return state.HasContent;
        }

        private async Task<ComposerState> ReadComposerAsync()
        {
            string raw;
            try
            {
                raw = await _cdp.EvaluateAsync(PageScripts.BuildComposerStateScript(CurrentProvider), 3000);
            }
            catch (Exception error)
            {
                Log.Warn("读取输入框状态失败: " + error.Message);
                return null;
            }
            return ComposerState.Parse(raw);
        }

        private async Task FocusComposerAsync()
        {
            try
            {
                await _cdp.EvaluateAsync(PageScripts.BuildFocusScript(CurrentProvider), 4000);
            }
            catch (Exception error)
            {
                Log.Warn("聚焦输入框失败: " + error.Message);
            }
            await Task.Delay(120);
        }

        /// <summary>页面内 new KeyboardEvent 的 isTrusted 是 false，React 会忽略；必须走 CDP 真实按键输入。</summary>
        private async Task<bool> DispatchEnterAsync()
        {
            try
            {
                bool ok = await _cdp.DispatchEnterAsync(4000);
                Log.Info("CDP 可信 Enter: " + (ok ? "ok" : "fail"));
                return ok;
            }
            catch (Exception error)
            {
                Log.Warn("CDP 可信 Enter 异常: " + error.Message);
                return false;
            }
        }

        /// <summary>
        /// 退路：URL 预填链接。只有 provider 配置了 PrefillParam 才走这条（目前仅 DeepSeek 的 q）。
        /// 预填不会自动发送，所以这里一律返回 false，不能假装成功。
        /// </summary>
        private async Task<bool> FallbackNavigateAsync(string prompt)
        {
            WebProvider provider = CurrentProvider;
            if (string.IsNullOrEmpty(provider.PrefillParam))
            {
                Log.Warn("[" + provider.Id + "] 该服务方不支持 URL 预填，判定为未发送");
                return false;
            }
            if (_cdp == null || !_cdp.IsConnected)
            {
                Log.Warn("退路：CDP 已断开，连预填链接都打不开，判定为未发送");
                return false;
            }
            string url = provider.BuildAskUrl(prompt);
            Log.Warn("退路：已用预填链接，但从预期来看不会自动发送: " + url);
            try
            {
                await _cdp.NavigateAsync(url, 8000);
                Log.Warn("已导航到预填链接，问题在输入框里，需要用户手动按 Enter 才会发出");
            }
            catch (Exception error)
            {
                Log.Warn("预填链接也没打开成功: " + error.Message);
            }
            return false;
        }

        /// <summary>
        /// 诊断用（BubbleAsk.Tests.exe --probe &lt;providerId&gt;）：
        /// 用真实浏览器打开该服务方，把输入框/发送按钮的候选元素信息导成 JSON，供实机校准选择器。
        /// 只读页面，注入和发送都不做。失败时返回 "ERR: ..."。
        /// </summary>
        public async Task<string> ProbeAsync(WebProvider provider)
        {
            try
            {
                await EnsureConnectedAsync(provider);
                // SPA 首屏可能还在渲染，多等一会儿，避免采集到空页面。
                await Task.Delay(2500);
                return await _cdp.EvaluateAsync(PageScripts.BuildProbeScript(CurrentProvider), 15000);
            }
            catch (Exception error)
            {
                Log.Error("探测页面失败", error);
                return "ERR: " + error.Message;
            }
        }
        /// <summary>发送后回读用的输入框快照。</summary>
        private sealed class ComposerState
        {
            public bool Found;
            public string Box = "none";
            public int Length;
            public bool HasText;
            public bool HasImage;
            public bool SendEnabled;

            /// <summary>发送前有没有东西可发（文字或图片附件）。</summary>
            public bool HasContent
            {
                get { return HasText || HasImage; }
            }

            public bool IsEmpty
            {
                get { return !HasText && !HasImage; }
            }

            public static ComposerState Parse(string raw)
            {
                ComposerState state = new ComposerState();
                if (string.IsNullOrEmpty(raw))
                {
                    return state;
                }
                try
                {
                    Dictionary<string, object> data = Json.ParseObject(raw);
                    state.Box = Json.GetString(data, "box", "none");
                    state.Length = Json.GetInt(data, "len", 0);
                    state.HasText = Json.GetBool(data, "text", false);
                    state.HasImage = Json.GetBool(data, "img", false);
                    state.SendEnabled = Json.GetBool(data, "send", false);
                    state.Found = state.Box != "none";
                }
                catch (Exception error)
                {
                    Log.Warn("输入框状态解析失败: " + error.Message + " :: " + raw);
                }
                return state;
            }

            public string Describe()
            {
                return "box=" + Box + " len=" + Length + " text=" + HasText +
                    " img=" + HasImage + " sendEnabled=" + SendEnabled;
            }
        }

        private void Reset()
        {
            if (_cdp != null)
            {
                _cdp.Dispose();
                _cdp = null;
            }
        }

        public void Dispose()
        {
            Reset();
        }
    }
}
