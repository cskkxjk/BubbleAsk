using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>把问题送进 Edge 里的聊天页面：优先 DOM 注入，失败退回 ?q= 链接。</summary>
    public class ChatDriver : IDisposable
    {
        private readonly AppConfig _config;
        private readonly EdgeHost _edge;
        private CdpClient _cdp;

        public ChatDriver(AppConfig config)
        {
            _config = config;
            _edge = new EdgeHost(config);
        }

        public EdgeHost Edge
        {
            get { return _edge; }
        }

        public void EnsureWindow()
        {
            _edge.ShowAndFocus();
        }

        public async Task<bool> AskAsync(string prompt)
        {
            if (string.IsNullOrEmpty(prompt))
            {
                return false;
            }
            for (int attempt = 0; attempt < 2; attempt++)
            {
                bool retry = false;
                try
                {
                    await EnsureConnectedAsync();
                    EnsureWindow();
                    await WaitForComposerAsync(25000);
                    string filled = await FillWithRetryAsync(prompt);
                    Log.Info("注入输入框结果: " + filled);
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
                        return true;
                    }
                    await Task.Delay(250);
                    string status = await SendAndVerifyAsync(true, 2000);
                    Log.Info("发送校验结果: " + status);
                    if (status == "sent")
                    {
                        return true;
                    }
                    if (NeedsPrefillFallback(status))
                    {
                        Log.Warn("发送没能触发（" + status + "），改走 ?q= 预填链接");
                        return await FallbackNavigateAsync(prompt);
                    }
                    // 已经点过发送但没能确认：别再导航（会丢掉当前会话，也可能其实已经发出去了），
                    // 保持页面原样让用户手动按 Enter。
                    Log.Warn("已点击发送但没能确认发出去（" + status + "），不导航，保持页面原样，请手动回车确认");
                    return false;
                }
                catch (Exception error)
                {
                    Log.Error("发送失败（第 " + (attempt + 1) + " 次）", error);
                    Reset();
                    retry = true;
                }
                if (retry)
                {
                    await Task.Delay(400);
                }
            }
            return false;
        }

        public async Task<bool> AskWithImageAsync(string imagePath, string prompt)
        {
            try
            {
                await EnsureConnectedAsync();
                EnsureWindow();
                await WaitForComposerAsync(25000);

                // 首选：把文件直接塞进页面的 file input，不碰剪贴板、不要求窗口有焦点。
                bool attached = await AttachImageAsync(imagePath);
                if (!attached)
                {
                    Log.Warn("没找到上传入口，退回剪贴板粘贴");
                    attached = await PasteImageAsync(imagePath);
                }
                if (!attached)
                {
                    Log.Warn("图片没能送进页面，退化为纯文本提问");
                    return await AskAsync(prompt);
                }

                await Task.Delay(700);

                if (!string.IsNullOrEmpty(prompt))
                {
                    string filled = await FillWithRetryAsync(prompt);
                    Log.Info("截图后注入文本: " + filled);
                    if (filled == "none" || filled == null || filled.StartsWith("failed", StringComparison.Ordinal))
                    {
                        Log.Warn("图文：文本没能写进输入框（" + filled + "），判定为未发送");
                        return false;
                    }
                    await Task.Delay(250);
                }

                if (!_config.AutoSend)
                {
                    Log.Info("自动发送已关闭，图文只贴上不发送");
                    return true;
                }

                string status = await SendAndVerifyAsync(!string.IsNullOrEmpty(prompt), 2000);
                Log.Info("图文发送校验结果: " + status);
                if (status == "sent")
                {
                    return true;
                }
                Log.Warn("图文发送未确认成功（" + status + "），不当作成功");
                return false;
            }
            catch (Exception error)
            {
                Log.Error("图文发送失败", error);
                Reset();
                return false;
            }
        }

        /// <summary>通过 CDP 往页面里的 file input 塞文件；找不到输入框就点一下上传按钮再找。</summary>
        private async Task<bool> AttachImageAsync(string imagePath)
        {
            try
            {
                string objectId = await _cdp.EvaluateHandleAsync(BuildFileInputScript(), 5000);
                if (string.IsNullOrEmpty(objectId))
                {
                    string opened = await _cdp.EvaluateAsync(BuildOpenUploadScript(), 4000);
                    Log.Info("打开上传入口: " + opened);
                    await Task.Delay(800);
                    objectId = await _cdp.EvaluateHandleAsync(BuildFileInputScript(), 5000);
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
            await _cdp.EvaluateAsync(BuildFocusScript(), 5000);
            await Task.Delay(200);
            ClipboardCapture.SendPaste();
            Log.Info("已向页面粘贴截图");
            await Task.Delay(900);
            return true;
        }

        public async Task<bool> OpenAsync()
        {
            try
            {
                await EnsureConnectedAsync();
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
        /// 返回值：true 表示这次是「关掉」。
        /// </summary>
        public async Task<bool> ToggleAsync()
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
                Log.Info("窗口在，拉到前台");
                _edge.ShowAndFocus();
                return false;
            }
            await OpenAsync();
            return false;
        }

        public async Task<string> GetStateAsync()
        {
            try
            {
                await EnsureConnectedAsync();
                return await _cdp.EvaluateAsync(BuildStateScript(), 5000);
            }
            catch (Exception error)
            {
                return "ERR: " + error.Message;
            }
        }

        /// <summary>在页面里求值，返回字符串结果。排查页面结构时用。</summary>
        public async Task<string> EvaluateAsync(string script)
        {
            await EnsureConnectedAsync();
            return await _cdp.EvaluateAsync(script, 8000);
        }

        private async Task EnsureConnectedAsync()
        {
            if (_cdp != null && _cdp.IsConnected)
            {
                return;
            }
            Reset();
            // 启动 Edge 可能要等十几秒，放到后台线程，别冻住界面。
            await Task.Run(new Action(delegate { _edge.EnsureStarted(); }));
            string origin = ChatOrigin();
            _cdp = new CdpClient();
            await _cdp.ConnectAsync(_config.CdpPort, origin, 20000);
            if (!_cdp.TargetUrl.StartsWith(origin, StringComparison.OrdinalIgnoreCase))
            {
                Log.Info("当前页面不是聊天页，导航到 " + _config.ChatUrl);
                await _cdp.NavigateAsync(_config.ChatUrl, 10000);
                await Task.Delay(1200);
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
        /// 返回 BuildFillScript 的原始结果（'textarea' / 'editable' / 'none' / 'failed:*'）。
        /// </summary>
        private async Task<string> FillWithRetryAsync(string prompt)
        {
            string filled = await _cdp.EvaluateAsync(BuildFillScript(prompt), 8000);
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
            return await _cdp.EvaluateAsync(BuildFillScript(prompt), 8000);
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
                action = await _cdp.EvaluateAsync(BuildSendScript(), 5000);
            }
            catch (Exception error)
            {
                Log.Warn("点击发送按钮异常: " + error.Message);
            }
            Log.Info("发送按钮回读: " + (action == null ? "null" : action));

            bool triggered = action != null && action.StartsWith("clicked", StringComparison.Ordinal);
            if (!triggered)
            {
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
                raw = await _cdp.EvaluateAsync(BuildComposerStateScript(), 3000);
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
                await _cdp.EvaluateAsync(BuildFocusScript(), 4000);
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
        /// 退路：?q= 预填链接。DeepSeek 会把问题填进输入框，但不会自动发送（autosend 不是它认的参数），
        /// 所以这里一律返回 false，不能再假装成功。
        /// </summary>
        private async Task<bool> FallbackNavigateAsync(string prompt)
        {
            if (_cdp == null || !_cdp.IsConnected)
            {
                Log.Warn("退路：CDP 已断开，连 ?q= 预填链接都打不开，判定为未发送");
                return false;
            }
            string url = BuildAskUrl(prompt);
            Log.Warn("退路：已用 ?q= 链接预填，但从预期来看不会自动发送: " + url);
            try
            {
                await _cdp.NavigateAsync(url, 8000);
                Log.Warn("已导航到 ?q= 预填链接，问题在输入框里，需要用户手动按 Enter 才会发出");
            }
            catch (Exception error)
            {
                Log.Warn("?q= 预填链接也没打开成功: " + error.Message);
            }
            return false;
        }

        private string BuildAskUrl(string prompt)
        {
            string baseUrl = _config.ChatUrl;
            string separator = baseUrl.IndexOf('?') >= 0 ? "&" : "?";
            // 只保留 q：DeepSeek 的 chat_url_prefill 只认 q/prompt/mode/search/thinking，autosend=1 无效，已删。
            return baseUrl + separator + "q=" + Uri.EscapeDataString(prompt);
        }

        private string ChatOrigin()
        {
            Uri uri;
            if (Uri.TryCreate(_config.ChatUrl, UriKind.Absolute, out uri))
            {
                return uri.GetLeftPart(UriPartial.Authority);
            }
            return "https://chat.deepseek.com";
        }

        /// <summary>诊断用：页面里输入框/发送按钮的存在与状态，GetStateAsync 直接把它返回给用户。</summary>
        private static string BuildStateScript()
        {
            return
                "(function(){" +
                SendButtonFuncs() +
                "var el=" + ComposerExpr() + ";" +
                "var btn=findSend();" +
                "var tag=el?String(el.tagName||'').toUpperCase():'';" +
                "var boxType=(tag==='TEXTAREA'||tag==='INPUT')?'textarea':(el?'editable':'none');" +
                "return JSON.stringify({hasBox:!!el,boxType:boxType,hasSend:!!btn,sendEnabled:!!(btn&&isEnabled(btn)),url:location.href,title:document.title});" +
                "})()";
        }

        private static string BuildFileInputScript()
        {
            return
                "(function(){" +
                "var inputs=document.querySelectorAll('input[type=\"file\"]');" +
                "for(var i=0;i<inputs.length;i++){return inputs[i];}" +
                "return null;" +
                "})()";
        }

        /// <summary>页面上的上传按钮通常只带图标，用 aria-label / title / data-testid 去认它。</summary>
        private static string BuildOpenUploadScript()
        {
            return
                "(function(){" +
                "var nodes=document.querySelectorAll('button,div[role=\"button\"],span[role=\"button\"],label');" +
                "for(var i=0;i<nodes.length;i++){" +
                "var n=nodes[i];" +
                "var label=(n.getAttribute('aria-label')||'')+' '+(n.getAttribute('title')||'')+' '+(n.getAttribute('data-testid')||'');" +
                "if(/上传|附件|图片|文件|attach|upload|image|photo|file/i.test(label)){n.click();return 'clicked:'+label;}" +
                "}" +
                "return 'none';" +
                "})()";
        }

        /// <summary>
        /// composer（输入框）的查找表达式，越往前优先级越高：保持原来的 textarea[name=search] → textarea
        /// → div[contenteditable] 顺序，再往后面补 p[contenteditable]、通用 contenteditable、
        /// role=textbox 以及常见的 data-testid，页面改版时尽量还能命中。
        /// </summary>
        private static string ComposerExpr()
        {
            return
                "(document.querySelector('textarea[name=\"search\"]')" +
                "||document.querySelector('textarea')" +
                "||document.querySelector('div[contenteditable=\"true\"]')" +
                "||document.querySelector('p[contenteditable=\"true\"]')" +
                "||document.querySelector('[contenteditable=\"true\"]')" +
                "||document.querySelector('[role=\"textbox\"]')" +
                "||document.querySelector('[data-testid=\"chat-input\"] textarea')" +
                "||document.querySelector('[data-testid=\"chat-input\"] [contenteditable=\"true\"]')" +
                "||document.querySelector('textarea[data-testid]')" +
                "||document.querySelector('[data-testid*=\"input\"] textarea')" +
                "||document.querySelector('[data-testid*=\"input\"] [contenteditable=\"true\"]')" +
                "||document.querySelector('[data-testid=\"chat-input\"]'))";
        }

        /// <summary>
        /// 页面里共用的发送按钮工具函数。查找顺序：
        /// 0) 结构化特征：输入框附近、role=button 且 class 同时含 ds-button--primary 与 ds-button--circle
        ///    —— 实测（Edge 156 + chat.deepseek.com 2026-11）页面上唯一命中，且不依赖图标长什么样；
        /// 1) aria-label / title / data-testid 命中 /发送|send|submit/i；
        /// 2) 含 svg 图标 + 语义提示（class 里写着 send 的图标按钮）；
        /// 3) 只看 className 的语义；
        /// 4) 最后才用过窄的 svg path 兜底（历史上漂移过，留着当保底）。
        /// 每一轮都在候选里取 DOM 最深的那个，避免点到包着真按钮的容器（点了不冒泡到按钮）。
        /// </summary>
        private static string SendButtonFuncs()
        {
            return
                "function attrLabel(n){if(!n||!n.getAttribute){return '';}" +
                "var a=n.getAttribute('aria-label')||'';" +
                "var t=n.getAttribute('title')||'';" +
                "var d=n.getAttribute('data-testid')||'';" +
                "return (a+' '+t+' '+d);}" +
                "function labelOf(n){return attrLabel(n)+' '+String((n&&n.className)||'');}" +
                "function visible(n){if(!n){return false;}" +
                "return !!(n.offsetWidth||n.offsetHeight||(n.getClientRects&&n.getClientRects().length));}" +
                "function isEnabled(n){if(!n){return false;}" +
                "if(n.disabled){return false;}" +
                "if(n.getAttribute&&n.getAttribute('aria-disabled')==='true'){return false;}" +
                "var cls=String(n.className||'');" +
                "if(/disabled/i.test(cls)){return false;}" +
                "return true;}" +
                "function depthOf(n){var d=0;while(n&&n.parentElement){d++;n=n.parentElement;}return d;}" +
                "function pick(nodes,test){" +
                "var best=null,bestDepth=-1,i,n,d;" +
                "for(i=0;i<nodes.length;i++){n=nodes[i];" +
                "if(!visible(n)){continue;}" +
                "if(!test(n)){continue;}" +
                "d=depthOf(n);" +
                "if(d>bestDepth){best=n;bestDepth=d;}}" +
                "return best;}" +
                // 结构化：composer 往上是几层，只在这块区域里找主按钮（避免命中顶部工具栏的 primary 按钮）。
                "function findSendStructural(){" +
                "var box=" + ComposerExpr() + ";" +
                "if(!box){return null;}" +
                "var scope=box;" +
                "for(var up=0;up<4&&scope;up++){scope=scope.parentElement;}" +
                "if(!scope){return null;}" +
                "return pick(scope.querySelectorAll('[role=\"button\"]'),function(n){" +
                "var c=String(n.className||'');" +
                "return c.indexOf('ds-button--primary')>=0&&c.indexOf('ds-button--circle')>=0;});}" +
                "function findSend(){" +
                "var t=findSendStructural();" +
                "if(t){return t;}" +
                "var nodes=document.querySelectorAll('button,[role=\"button\"],[data-testid],div,span');" +
                "t=pick(nodes,function(n){return /发送|send|submit/i.test(attrLabel(n));});" +
                "if(t){return t;}" +
                "t=pick(nodes,function(n){return !!(n.querySelector&&n.querySelector('svg')&&/send|submit|arrow|paper|plane/i.test(labelOf(n)));});" +
                "if(t){return t;}" +
                "t=pick(nodes,function(n){return /发送|send|submit/i.test(String(n.className||''));});" +
                "if(t){return t;}" +
                "t=pick(nodes,function(n){return !!(n.querySelector&&n.querySelector('svg path[d^=\"M8.3125\"]'));});" +
                "if(t){return t;}" +
                "return null;}";
        }

        /// <summary>输入框状态的回读脚本：文本长度、是否有图片附件、发送按钮是否可用。</summary>
        private static string BuildComposerStateScript()
        {
            return
                "(function(){" +
                SendButtonFuncs() +
                "function textOf(el){" +
                "var tag=(el.tagName||'').toUpperCase();" +
                "var t=(tag==='TEXTAREA'||tag==='INPUT')?(el.value||''):(el.innerText||el.textContent||'');" +
                "return String(t).replace(/[\\s\\u200b\\u00a0\\ufeff]/g,'');}" +
                "var el=" + ComposerExpr() + ";" +
                "if(!el){return JSON.stringify({box:'none',len:0,text:false,img:false,send:false,url:location.href});}" +
                "var tag=(el.tagName||'').toUpperCase();" +
                "var box=(tag==='TEXTAREA'||tag==='INPUT')?'textarea':'editable';" +
                "var plain=textOf(el);" +
                "var hasImg=!!(el.querySelector&&el.querySelector('img,image'));" +
                "var btn=findSend();" +
                "return JSON.stringify({box:box,len:plain.length,text:plain.length>0,img:hasImg,send:!!(btn&&isEnabled(btn)),url:location.href});" +
                "})()";
        }

        private static string BuildFocusScript()
        {
            return
                "(function(){" +
                "var el=" + ComposerExpr() + ";" +
                "if(!el){return 'none';}" +
                "try{el.focus();}catch(e){return 'failed:focus';}" +
                "return 'ok';" +
                "})()";
        }

        private static string BuildFillScript(string prompt)
        {
            string literal = Json.Stringify(prompt);
            return
                "(function(){" +
                "var text=" + literal + ";" +
                "function fire(el){" +
                "el.dispatchEvent(new Event('input',{bubbles:true}));" +
                "el.dispatchEvent(new Event('change',{bubbles:true}));" +
                "}" +
                "function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\r?\\n/g,'<br>');}" +
                "var el=" + ComposerExpr() + ";" +
                "if(!el){return 'none';}" +
                "var tag=(el.tagName||'').toUpperCase();" +
                "if(tag==='TEXTAREA'||tag==='INPUT'){" +
                "var proto=(tag==='INPUT')?window.HTMLInputElement.prototype:window.HTMLTextAreaElement.prototype;" +
                "var desc=Object.getOwnPropertyDescriptor(proto,'value');" +
                "var setter=desc?desc.set:null;" +
                "if(!setter){return 'failed:nosetter';}" +
                "try{setter.call(el,text);}catch(e){return 'failed:setter';}" +
                "if(el.value!==text){return 'failed:readback';}" +
                "fire(el);" +
                "try{el.focus();}catch(e){}" +
                "if(el.value!==text){return 'failed:reverted';}" +
                "return 'textarea';" +
                "}" +
                "try{el.focus();}catch(e){}" +
                "try{document.execCommand('selectAll',false,null);}catch(e){}" +
                "var ok=false;" +
                "try{ok=document.execCommand('insertText',false,text);}catch(e){ok=false;}" +
                "if(!ok){try{ok=document.execCommand('insertHTML',false,esc(text));}catch(e){ok=false;}}" +
                "if(!ok){return 'failed:execCommand';}" +
                "fire(el);" +
                "var got=String(el.innerText||el.textContent||'').replace(/[\\s\\u200b\\u00a0]+/g,'');" +
                "if(!got){return 'failed:empty';}" +
                "return 'editable';" +
                "})()";
        }

        /// <summary>
        /// 只负责「点」发送按钮，不再在页面里伪造 KeyboardEvent（isTrusted:false，React 会忽略）；
        /// Enter 退路由 C# 侧走 CDP 的 Input.dispatchKeyEvent。
        /// </summary>
        private static string BuildSendScript()
        {
            return
                "(function(){" +
                SendButtonFuncs() +
                "var target=findSend();" +
                "if(!target){return 'nobutton';}" +
                "var label=labelOf(target);" +
                "if(!isEnabled(target)){return 'disabled:'+label;}" +
                "try{target.click();}catch(e){return 'failed:click';}" +
                "return 'clicked:'+label;" +
                "})()";
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
