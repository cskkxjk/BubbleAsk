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
                    await WaitForComposerAsync(10000);
                    string filled = await _cdp.EvaluateAsync(BuildFillScript(prompt), 8000);
                    Log.Info("注入输入框结果: " + filled);
                    if (filled == "none")
                    {
                        return await FallbackNavigateAsync(prompt);
                    }
                    if (!_config.AutoSend)
                    {
                        Log.Info("自动发送已关闭，只填入不发送");
                        return true;
                    }
                    await Task.Delay(250);
                    string sent = await ClickSendWithRetryAsync();
                    Log.Info("发送结果: " + sent);
                    if (sent == "clicked" || sent == "enter")
                    {
                        return true;
                    }
                    return await FallbackNavigateAsync(prompt);
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
                await WaitForComposerAsync(10000);

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
                    string filled = await _cdp.EvaluateAsync(BuildFillScript(prompt), 8000);
                    Log.Info("截图后注入文本: " + filled);
                    await Task.Delay(250);
                }

                if (!_config.AutoSend)
                {
                    Log.Info("自动发送已关闭，图文只贴上不发送");
                    return true;
                }

                string sent = await ClickSendWithRetryAsync();
                Log.Info("图文发送结果: " + sent);
                return sent == "clicked" || sent == "enter";
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

        private async Task WaitForComposerAsync(int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                string state = await _cdp.EvaluateAsync(BuildStateScript(), 4000);
                if (!string.IsNullOrEmpty(state) && state.IndexOf("\"hasBox\":true", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return;
                }
                await Task.Delay(300);
                waited += 300;
            }
            Log.Warn("等待输入框超时，继续尝试注入");
        }

        private async Task<string> ClickSendWithRetryAsync()
        {
            string last = "none";
            for (int i = 0; i < 6; i++)
            {
                last = await _cdp.EvaluateAsync(BuildSendScript(), 5000);
                if (last == "clicked" || last == "enter")
                {
                    return last;
                }
                await Task.Delay(250);
            }
            return last;
        }

        private async Task<bool> FallbackNavigateAsync(string prompt)
        {
            if (_cdp == null || !_cdp.IsConnected)
            {
                return false;
            }
            string url = BuildAskUrl(prompt);
            Log.Info("退回链接方式: " + url);
            await _cdp.NavigateAsync(url, 8000);
            return true;
        }

        private string BuildAskUrl(string prompt)
        {
            string baseUrl = _config.ChatUrl;
            string separator = baseUrl.IndexOf('?') >= 0 ? "&" : "?";
            string url = baseUrl + separator + "q=" + Uri.EscapeDataString(prompt);
            if (_config.AutoSend)
            {
                url += "&autosend=1";
            }
            return url;
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

        private static string BuildStateScript()
        {
            return
                "(function(){" +
                "var box=document.querySelector('textarea[name=\"search\"]')||document.querySelector('textarea')||document.querySelector('div[contenteditable=\"true\"]');" +
                "var buttons=document.querySelectorAll('button, div[role=\"button\"]');" +
                "var hasSend=false;" +
                "for(var i=0;i<buttons.length;i++){var b=buttons[i];var label=(b.getAttribute('aria-label')||'')+' '+(b.getAttribute('title')||'');if(/发送|send/i.test(label)){hasSend=true;break;}}" +
                "return JSON.stringify({hasBox:!!box,hasSend:hasSend,url:location.href,title:document.title});" +
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

        private static string BuildFocusScript()
        {
            return
                "(function(){" +
                "var el=document.querySelector('textarea[name=\"search\"]')||document.querySelector('textarea')||document.querySelector('div[contenteditable=\"true\"]');" +
                "if(!el){return 'none';}" +
                "el.focus();" +
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
                "var ta=document.querySelector('textarea[name=\"search\"]')||document.querySelector('textarea');" +
                "if(ta){" +
                "var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;" +
                "setter.call(ta,text);fire(ta);ta.focus();" +
                "return 'textarea';" +
                "}" +
                "var ed=document.querySelector('div[contenteditable=\"true\"]');" +
                "if(ed){" +
                "ed.focus();" +
                "document.execCommand('selectAll',false,null);" +
                "document.execCommand('insertText',false,text);" +
                "fire(ed);" +
                "return 'editable';" +
                "}" +
                "return 'none';" +
                "})()";
        }

        private static string BuildSendScript()
        {
            return
                "(function(){" +
                "var target=null;" +
                "var nodes=document.querySelectorAll('button, div[role=\"button\"]');" +
                "for(var i=0;i<nodes.length;i++){" +
                "var n=nodes[i];" +
                "var label=(n.getAttribute('aria-label')||'')+' '+(n.getAttribute('title')||'');" +
                "if(/发送|send/i.test(label)){target=n;break;}" +
                "if(n.querySelector&&n.querySelector('svg path[d^=\"M8.3125\"]')){target=n;break;}" +
                "}" +
                "if(target){" +
                "var cls=String(target.className||'');" +
                "var disabled=target.disabled||target.getAttribute('aria-disabled')==='true'||cls.indexOf('disabled')>=0;" +
                "if(!disabled){target.click();return 'clicked';}" +
                "return 'disabled';" +
                "}" +
                "var box=document.querySelector('textarea')||document.querySelector('div[contenteditable=\"true\"]');" +
                "if(box){" +
                "box.focus();" +
                "var types=['keydown','keypress','keyup'];" +
                "for(var k=0;k<types.length;k++){" +
                "box.dispatchEvent(new KeyboardEvent(types[k],{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));" +
                "}" +
                "return 'enter';" +
                "}" +
                "return 'none';" +
                "})()";
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
