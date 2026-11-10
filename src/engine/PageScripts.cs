using System;
using System.Collections.Generic;
using System.Text;

namespace BubbleAsk
{
    /// <summary>
    /// 页面脚本生成器：把 <see cref="WebProvider"/> 的选择器拼成注入页面的 JS。
    ///
    /// 之所以单独成一个文件：所有「站点差异」都收敛到 WebProviders 的数据里，
    /// 这里只负责通用查找逻辑与脚本拼装。脚本在浏览器页面里执行（CDP Runtime.evaluate），
    /// 因此只能用 ES5 语法，且不能用浏览器扩展 API。
    ///
    /// 自测（src/tests/TestProgram.cs）直接调用本类的 internal 方法断言脚本里带上了
    /// 对应服务方的选择器，页面改版后也方便改一处、测一处。
    /// </summary>
    internal static class PageScripts
    {
        // ---------- 通用工具 ----------

        private static string JsString(string value)
        {
            if (value == null)
            {
                return "''";
            }
            StringBuilder builder = new StringBuilder(value.Length + 2);
            builder.Append('\'');
            for (int i = 0; i < value.Length; i++)
            {
                char current = value[i];
                if (current == '\\')
                {
                    builder.Append("\\\\");
                }
                else if (current == '\'')
                {
                    builder.Append("\\'");
                }
                else if (current == '\r')
                {
                    builder.Append("\\r");
                }
                else if (current == '\n')
                {
                    builder.Append("\\n");
                }
                else
                {
                    builder.Append(current);
                }
            }
            builder.Append('\'');
            return builder.ToString();
        }

        private static string JsArray(string[] values)
        {
            if (values == null || values.Length == 0)
            {
                return "[]";
            }
            StringBuilder builder = new StringBuilder("[");
            for (int i = 0; i < values.Length; i++)
            {
                if (i > 0)
                {
                    builder.Append(',');
                }
                builder.Append(JsString(values[i]));
            }
            builder.Append(']');
            return builder.ToString();
        }

        private static void AddUnique(List<string> list, string selector, bool atFront)
        {
            if (string.IsNullOrEmpty(selector))
            {
                return;
            }
            for (int i = 0; i < list.Count; i++)
            {
                if (string.Equals(list[i], selector, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
            }
            if (atFront)
            {
                list.Insert(0, selector);
            }
            else
            {
                list.Add(selector);
            }
        }

        /// <summary>
        /// 实际用于找输入框的选择器：provider 专属的优先，再补上通用兜底
        /// （可见 textarea / contenteditable / role=textbox）。重复的自动去掉，顺序不变。
        ///
        /// 通用兜底同样来自真源（shared/providers.json 的 generic.composerSelectors），
        /// 与扩展里的那套保持同一份定义。
        /// </summary>
        internal static string[] AllComposerSelectors(WebProvider provider)
        {
            List<string> list = new List<string>();
            if (provider != null && provider.ComposerSelectors != null)
            {
                for (int i = 0; i < provider.ComposerSelectors.Length; i++)
                {
                    AddUnique(list, provider.ComposerSelectors[i], false);
                }
            }
            string[] generic = ProviderData.GenericComposerSelectors;
            for (int i = 0; i < generic.Length; i++)
            {
                AddUnique(list, generic[i], false);
            }
            return list.ToArray();
        }

        /// <summary>
        /// 发送按钮文案兜底的「正则源码」（不含斜杠与 flag），来自真源 generic.sendAriaLabels。
        /// 例：发送|send|submit|提交
        /// </summary>
        private static string LabelPattern()
        {
            string[] labels = ProviderData.GenericSendAriaLabels;
            if (labels == null || labels.Length == 0)
            {
                return "发送|send|submit";
            }
            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < labels.Length; i++)
            {
                string label = labels[i];
                if (label == null || label.Length == 0)
                {
                    continue;
                }
                if (builder.Length > 0)
                {
                    builder.Append('|');
                }
                builder.Append(EscapeRegex(label));
            }
            return builder.Length == 0 ? "发送|send|submit" : builder.ToString();
        }

        /// <summary>把字面量转成可以安全放进正则的片段。</summary>
        private static string EscapeRegex(string value)
        {
            const string special = "\\^$.|?*+()[]{}";
            StringBuilder builder = new StringBuilder(value.Length * 2);
            for (int i = 0; i < value.Length; i++)
            {
                char current = value[i];
                if (special.IndexOf(current) >= 0)
                {
                    builder.Append('\\');
                }
                builder.Append(current);
            }
            return builder.ToString();
        }

        /// <summary>可见性、深度、候选挑选、输入框查找等公共函数（每个脚本里都会带上）。</summary>
        private static string Helpers(WebProvider provider)
        {
            return
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
                // 先按「可见」找；全都不可见时退回第一个（隐藏的模板/旧节点也算存在，交给后续逻辑判断）。
                "function firstVisible(selectors){" +
                "var i,j,els;" +
                "for(i=0;i<selectors.length;i++){" +
                "try{els=document.querySelectorAll(selectors[i]);}catch(e){continue;}" +
                "for(j=0;j<els.length;j++){if(visible(els[j])){return els[j];}}}" +
                "for(i=0;i<selectors.length;i++){" +
                "try{var el=document.querySelector(selectors[i]);}catch(e){continue;}" +
                "if(el){return el;}}" +
                "return null;}" +
                "var COMPOSER_SELECTORS=" + JsArray(AllComposerSelectors(provider)) + ";" +
                "function findComposer(){return firstVisible(COMPOSER_SELECTORS);}";
        }

        /// <summary>
        /// 发送按钮的查找函数。查找顺序（通用规则，与 provider 数据组合）：
        ///   1) provider 专属 CSS（SendSelectors）；
        ///   2) provider 的 class 特征（SendClassHints，只在输入框附近 4 层内找，DeepSeek 走这条）；
        ///   3) provider 的 aria/label 文案（SendAriaLabels）；
        ///   4) aria-label / title / data-testid 含 发送|send|submit；
        ///   5) 输入框附近 4 层内最后一个「只有图标没有文字」的按钮（新的通用兜底）；
        ///   6) svg 图标 + 语义 class；7) className 语义；8) provider 的 svg path 前缀（历史兜底）。
        /// 每一轮都在候选里取 DOM 最深的那个，避免点到包着真按钮的容器（点了不冒泡到按钮）。
        /// </summary>
        private static string SendButtonFuncs(WebProvider provider)
        {
            return
                "function attrLabel(n){if(!n||!n.getAttribute){return '';}" +
                "var a=n.getAttribute('aria-label')||'';" +
                "var t=n.getAttribute('title')||'';" +
                "var d=n.getAttribute('data-testid')||'';" +
                "return (a+' '+t+' '+d);}" +
                "function labelOf(n){return attrLabel(n)+' '+String((n&&n.className)||'');}" +
                "function selectorNodes(selectors){" +
                "var out=[],i,els,j;" +
                "for(i=0;i<selectors.length;i++){" +
                "try{els=document.querySelectorAll(selectors[i]);}catch(e){continue;}" +
                "for(j=0;j<els.length;j++){out.push(els[j]);}}" +
                "return out;}" +
                "function buttonText(n){return String(n.innerText||n.textContent||'').replace(/[\\s\\u200b\\u00a0]/g,'');}" +
                "function iconOnly(n){return !buttonText(n)&&!!(n.querySelector&&n.querySelector('svg'));}" +
                "function nearComposer(depth){var box=findComposer();if(!box){return null;}" +
                "var scope=box;for(var up=0;up<depth&&scope;up++){scope=scope.parentElement;}return scope;}" +
                "function classMatches(n,hints){var c=String(n.className||'');" +
                "for(var i=0;i<hints.length;i++){if(c.indexOf(hints[i])<0){return false;}}return true;}" +
                "function findSend(){" +
                "var t=pick(selectorNodes(" + JsArray(provider.SendSelectors) + "),function(n){return true;});" +
                "if(t){return t;}" +
                "var hints=" + JsArray(provider.SendClassHints) + ";" +
                "if(hints.length){var scope=nearComposer(4);" +
                "if(scope){t=pick(scope.querySelectorAll('button,[role=\"button\"]'),function(n){return classMatches(n,hints);});" +
                "if(t){return t;}}}" +
                "var nodes=document.querySelectorAll('button,[role=\"button\"],[data-testid],div,span');" +
                "var labels=" + JsArray(provider.SendAriaLabels) + ";" +
                "if(labels.length){t=pick(nodes,function(n){var a=attrLabel(n).toLowerCase();" +
                "for(var i=0;i<labels.length;i++){if(a.indexOf(labels[i].toLowerCase())>=0){return true;}}return false;});" +
                "if(t){return t;}}" +
                "t=pick(nodes,function(n){return /" + LabelPattern() + "/i.test(attrLabel(n));});" +
                "if(t){return t;}" +
                "var scope2=nearComposer(4);" +
                "if(scope2){var near=scope2.querySelectorAll('button,[role=\"button\"]');" +
                "var lastIcon=null;" +
                "for(var k=0;k<near.length;k++){if(visible(near[k])&&iconOnly(near[k])){lastIcon=near[k];}}" +
                "if(lastIcon){return lastIcon;}}" +
                "t=pick(nodes,function(n){return !!(n.querySelector&&n.querySelector('svg')" +
                "&&/send|submit|arrow|paper|plane/i.test(labelOf(n)));});" +
                "if(t){return t;}" +
                "t=pick(nodes,function(n){return /" + LabelPattern() + "/i.test(String(n.className||''));});" +
                "if(t){return t;}" +
                "var paths=" + JsArray(provider.SendSvgPaths) + ";" +
                "if(paths.length){t=pick(nodes,function(n){" +
                "if(!(n.querySelector&&n.querySelector('svg path'))){return false;}" +
                "var ps=n.querySelectorAll('svg path');" +
                "for(var q=0;q<ps.length;q++){var d=String(ps[q].getAttribute('d')||'');" +
                "for(var z=0;z<paths.length;z++){if(d.indexOf(paths[z])===0){return true;}}}});" +
                "if(t){return t;}}" +
                "return null;}";
        }

        // ---------- 对外脚本（ChatDriver 注入页面） ----------

        /// <summary>诊断用：页面里输入框/发送按钮的存在与状态，GetStateAsync 直接把它返回给用户。</summary>
        internal static string BuildStateScript(WebProvider provider)
        {
            return
                "(function(){" +
                Helpers(provider) +
                SendButtonFuncs(provider) +
                "var el=findComposer();" +
                "var btn=findSend();" +
                "var tag=el?String(el.tagName||'').toUpperCase():'';" +
                "var boxType=(tag==='TEXTAREA'||tag==='INPUT')?'textarea':(el?'editable':'none');" +
                "return JSON.stringify({hasBox:!!el,boxType:boxType,hasSend:!!btn,sendEnabled:!!(btn&&isEnabled(btn))," +
                "url:location.href,title:document.title,provider:" + JsString(provider.Id) + "});" +
                "})()";
        }

        /// <summary>页面里第一个 file input（上传图片用，不要求可见）。</summary>
        internal static string BuildFileInputScript()
        {
            return
                "(function(){" +
                "var inputs=document.querySelectorAll('input[type=\"file\"]');" +
                "for(var i=0;i<inputs.length;i++){return inputs[i];}" +
                "return null;" +
                "})()";
        }

        /// <summary>页面上的上传按钮通常只带图标，用 aria-label / title / data-testid 去认它。</summary>
        internal static string BuildOpenUploadScript()
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

        /// <summary>输入框状态的回读脚本：文本长度、是否有图片附件、发送按钮是否可用。</summary>
        internal static string BuildComposerStateScript(WebProvider provider)
        {
            return
                "(function(){" +
                Helpers(provider) +
                SendButtonFuncs(provider) +
                "function textOf(el){" +
                "var tag=(el.tagName||'').toUpperCase();" +
                "var t=(tag==='TEXTAREA'||tag==='INPUT')?(el.value||''):(el.innerText||el.textContent||'');" +
                "return String(t).replace(/[\\s\\u200b\\u00a0\\ufeff]/g,'');}" +
                "var el=findComposer();" +
                "if(!el){return JSON.stringify({box:'none',len:0,text:false,img:false,send:false,url:location.href});}" +
                "var tag=(el.tagName||'').toUpperCase();" +
                "var box=(tag==='TEXTAREA'||tag==='INPUT')?'textarea':'editable';" +
                "var plain=textOf(el);" +
                "var hasImg=!!(el.querySelector&&el.querySelector('img,image'));" +
                "var btn=findSend();" +
                "return JSON.stringify({box:box,len:plain.length,text:plain.length>0,img:hasImg," +
                "send:!!(btn&&isEnabled(btn)),url:location.href});" +
                "})()";
        }

        internal static string BuildFocusScript(WebProvider provider)
        {
            return
                "(function(){" +
                Helpers(provider) +
                "var el=findComposer();" +
                "if(!el){return 'none';}" +
                "try{el.focus();}catch(e){return 'failed:focus';}" +
                "return 'ok';" +
                "})()";
        }

        internal static string BuildFillScript(WebProvider provider, string prompt)
        {
            string literal = Json.Stringify(prompt == null ? "" : prompt);
            return
                "(function(){" +
                Helpers(provider) +
                "var text=" + literal + ";" +
                "function fire(el){" +
                "el.dispatchEvent(new Event('input',{bubbles:true}));" +
                "el.dispatchEvent(new Event('change',{bubbles:true}));" +
                "}" +
                "function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\r?\\n/g,'<br>');}" +
                "var el=findComposer();" +
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
        /// 只负责「点」发送按钮，不在页面里伪造 KeyboardEvent（isTrusted:false，React 会忽略）；
        /// Enter 退路由 C# 侧走 CDP 的 Input.dispatchKeyEvent。
        /// </summary>
        internal static string BuildSendScript(WebProvider provider)
        {
            return
                "(function(){" +
                Helpers(provider) +
                SendButtonFuncs(provider) +
                "var target=findSend();" +
                "if(!target){return 'nobutton';}" +
                "var label=labelOf(target);" +
                "if(!isEnabled(target)){return 'disabled:'+label;}" +
                "try{target.click();}catch(e){return 'failed:click';}" +
                "return 'clicked:'+label;" +
                "})()";
        }

        /// <summary>
        /// 诊断脚本（--probe 用）：把页面上输入框/发送按钮的候选元素信息导成 JSON，
        /// 供后续实机校准 WebProviders 里的选择器。不修改页面。
        /// </summary>
        internal static string BuildProbeScript(WebProvider provider)
        {
            string verify = "null";
            if (!string.IsNullOrEmpty(provider.VerifyUrlRegex))
            {
                verify = "new RegExp(" + JsString(provider.VerifyUrlRegex) + ").test(location.href)";
            }
            return
                "(function(){" +
                Helpers(provider) +
                SendButtonFuncs(provider) +
                "function info(n){if(!n){return null;}" +
                "var r=n.getBoundingClientRect();" +
                "return {tag:String(n.tagName||'').toLowerCase(),id:n.id||''," +
                "cls:String(n.className||'').slice(0,160)," +
                "aria:n.getAttribute('aria-label')||'',title:n.getAttribute('title')||''," +
                "testid:n.getAttribute('data-testid')||'',role:n.getAttribute('role')||''," +
                "placeholder:n.getAttribute('placeholder')||''," +
                "visible:visible(n),w:Math.round(r.width),h:Math.round(r.height)};}" +
                "function list(selectors){var out=[],i,els,j;" +
                "for(i=0;i<selectors.length;i++){" +
                "try{els=document.querySelectorAll(selectors[i]);}catch(e){out.push({selector:selectors[i],error:String(e.message||e)});continue;}" +
                "for(j=0;j<els.length&&j<5;j++){out.push({selector:selectors[i],match:info(els[j])});}}" +
                "return out;}" +
                // LoginMarkers 是 URL 片段（不是 CSS）：命中即视为停在登录页。
                "var href=location.href.toLowerCase();" +
                "var LOGIN=" + JsArray(provider.LoginMarkers) + ";" +
                "var loginHits=[],loginLikely=false,li,lk;" +
                "for(li=0;li<LOGIN.length;li++){lk=String(LOGIN[li]||'').toLowerCase();" +
                "var matched=lk.length>0&&href.indexOf(lk)>=0;" +
                "if(matched){loginLikely=true;}" +
                "loginHits.push({marker:LOGIN[li],matched:matched});}" +
                "var buttons=document.querySelectorAll('button,[role=\"button\"]');" +
                "var candidates=[],i;" +
                "for(i=0;i<buttons.length&&candidates.length<20;i++){" +
                "if(!visible(buttons[i])){continue;}candidates.push(info(buttons[i]));}" +
                "return JSON.stringify({" +
                "provider:" + JsString(provider.Id) + "," +
                "name:" + JsString(provider.Name) + "," +
                "entryUrl:" + JsString(provider.Url) + "," +
                "url:location.href,title:document.title,ready:document.readyState," +
                "verifyUrl:" + verify + "," +
                "loginLikely:loginLikely," +
                "loginMarkers:loginHits," +
                "composer:info(findComposer())," +
                "composerCandidates:list(COMPOSER_SELECTORS)," +
                "send:info(findSend())," +
                "sendCandidates:list(" + JsArray(provider.SendSelectors) + ")," +
                "buttons:candidates});" +
                "})()";
        }
    }
}
