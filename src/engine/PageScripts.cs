using System;
using System.Collections.Generic;

namespace BubbleAsk
{
    /// <summary>
    /// 注入页面的脚本**拼装器**。
    ///
    /// 页面里的一切动作（找输入框、填充、找发送按钮、点击、回读、诊断）都在
    /// `shared/driver.js` 里 —— 那是与 Chrome 扩展共用的唯一实现。
    /// 本类只做两件事：
    ///
    ///   1. 把当前 provider 与通用兜底打包成一个配置对象（数据来自 shared/providers.json）；
    ///   2. 在前面带上 driver 源码，末尾调用对应操作，交给 CDP 的 Runtime.evaluate 执行。
    ///
    /// driver 自身是幂等的（已注入过就直接 return），所以每次调用都带一遍是安全的；
    /// 好处是页面跳转后不需要额外补注入。
    ///
    /// 返回值的字符串契约与合并前完全一致（'textarea' / 'clicked:...' / 'nobutton' …），
    /// ChatDriver 的解析逻辑不需要改。
    /// </summary>
    internal static class PageScripts
    {
        // ---------- 配置 ----------

        /// <summary>
        /// 把 provider 打包成 driver 需要的 cfg。
        ///
        /// 通用兜底（genericComposerSelectors / genericSendAriaLabels）也在这里带上，
        /// 保证桌面端与扩展用的是同一份数据 —— 它们都来自 shared/providers.json。
        /// </summary>
        internal static string ProviderConfigJson(WebProvider provider)
        {
            WebProvider source = provider ?? WebProviders.DefaultProvider;
            Dictionary<string, object> cfg = new Dictionary<string, object>();
            cfg["id"] = source.Id;
            cfg["name"] = source.Name;
            cfg["url"] = source.Url;
            cfg["origins"] = source.Origins;
            cfg["composerSelectors"] = source.ComposerSelectors;
            cfg["sendSelectors"] = source.SendSelectors;
            cfg["sendClassHints"] = source.SendClassHints;
            cfg["sendSvgPaths"] = source.SendSvgPaths;
            cfg["sendAriaLabels"] = source.SendAriaLabels;
            cfg["enterSends"] = source.EnterSends;
            cfg["loginMarkers"] = source.LoginMarkers;
            cfg["verifyUrlRegex"] = source.VerifyUrlRegex;
            cfg["prefillParam"] = source.PrefillParam;
            cfg["genericComposerSelectors"] = ProviderData.GenericComposerSelectors;
            cfg["genericSendAriaLabels"] = ProviderData.GenericSendAriaLabels;
            return Json.Stringify(cfg);
        }

        /// <summary>driver 源码 + 本次的 cfg（写成全局变量，供后面的调用表达式使用）。</summary>
        private static string Preamble(WebProvider provider)
        {
            return DriverScript.Source + "\n;var __baCfg=" + ProviderConfigJson(provider) + ";";
        }

        /// <summary>driver + cfg + 一次操作调用（返回 driver 的原始结果）。</summary>
        private static string Call(WebProvider provider, string expression)
        {
            return Preamble(provider) + "\n;(function(){return " + expression + ";})()";
        }

        // ---------- 对外脚本（ChatDriver 注入页面） ----------

        /// <summary>概览：输入框/发送按钮是否存在、是否可用（ChatDriver.GetStateAsync）。</summary>
        internal static string BuildStateScript(WebProvider provider)
        {
            return Call(provider, "__bubbleAskDriver.state(__baCfg)");
        }

        /// <summary>页面里第一个 file input（上传图片用，取 element handle）。</summary>
        internal static string BuildFileInputScript()
        {
            return DriverScript.Source + "\n;(function(){return __bubbleAskDriver.fileInput();})()";
        }

        /// <summary>点上传按钮（通常只有图标，靠 aria/title 认）。</summary>
        internal static string BuildOpenUploadScript()
        {
            return DriverScript.Source + "\n;(function(){return __bubbleAskDriver.openUpload();})()";
        }

        /// <summary>输入框回读：文本长度、是否有图片、发送按钮是否可用。</summary>
        internal static string BuildComposerStateScript(WebProvider provider)
        {
            return Call(provider, "__bubbleAskDriver.composerState(__baCfg)");
        }

        /// <summary>聚焦输入框。</summary>
        internal static string BuildFocusScript(WebProvider provider)
        {
            return Call(provider, "__bubbleAskDriver.focus(__baCfg)");
        }

        /// <summary>把提问写进输入框。返回 'textarea' / 'editable' / 'none' / 'failed:*'。</summary>
        internal static string BuildFillScript(WebProvider provider, string prompt)
        {
            return Call(provider, "__bubbleAskDriver.fill(__baCfg," + Json.Stringify(prompt == null ? "" : prompt) + ")");
        }

        /// <summary>
        /// 点发送按钮。返回 'nobutton' / 'disabled:...' / 'failed:click' / 'clicked:...'。
        ///
        /// 不在页面里伪造 KeyboardEvent（isTrusted=false，站点可以不认）；Enter 兜底已全站关闭，
        /// 找不到按钮就如实返回 nobutton，由用户自己处理。
        /// </summary>
        internal static string BuildSendScript(WebProvider provider)
        {
            return Call(provider, "__bubbleAskDriver.send(__baCfg)");
        }

        /// <summary>诊断脚本（--probe 用）：候选输入框/发送按钮信息导成 JSON，不修改页面。</summary>
        internal static string BuildProbeScript(WebProvider provider)
        {
            return Call(provider, "__bubbleAskDriver.probe(__baCfg)");
        }
    }
}
