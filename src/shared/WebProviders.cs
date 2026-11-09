using System;
using System.Collections.Generic;

namespace BubbleAsk
{
    /// <summary>
    /// 网页版服务方（provider）的配置信息。
    ///
    /// 把「哪个站点、输入框/发送按钮长什么样、怎么校验地址、能不能 URL 预填、要不要上传图片」
    /// 从 ChatDriver 里抽成纯数据。以后加站点或按页面改版校准选择器，只改本文件即可。
    ///
    /// 字段与使用位置：
    ///   Id / Name / Url        —— 导航目标、日志、设置页下拉；
    ///   Origins                —— 判断「当前页面是不是这个站点」（后缀匹配）；
    ///   ComposerSelectors      —— 输入框 CSS，按优先级排列，最后还有通用兜底；
    ///   SendSelectors          —— 发送按钮 CSS（provider 专属，优先级最高）；
    ///   SendAriaLabels         —— 发送按钮 aria-label / title / data-testid 里的显式文案；
    ///   SendClassHints         —— 发送按钮 class 特征（要求同时出现，且只在输入框附近找）；
    ///   SendSvgPaths           —— 历史遗留兜底：按 svg path 的 d 前缀认发送按钮；
    ///   EnterSends             —— 找不到发送按钮时，是否允许用 CDP 可信 Enter 兜底；
    ///   LoginMarkers           —— 登录页 URL 片段（如 "login"/"signin"/"accounts.google.com"），
    ///                             当前地址命中即为「停留在登录页」，用于日志提示与 --probe 诊断；
    ///   VerifyUrlRegex         —— 导航后地址应匹配的正则（.NET 与 JS 都可用）；
    ///   PrefillParam           —— URL 预填参数名（如 "q"），空串表示该站点不支持；
    ///   Upload                 —— 是否尝试图片上传（页内 file input → 剪贴板粘贴）。
    /// </summary>
    public class WebProvider
    {
        public string Id = "";
        public string Name = "";
        public string Url = "";
        public string[] Origins = new string[0];
        public string[] ComposerSelectors = new string[0];
        public string[] SendSelectors = new string[0];
        public string[] SendAriaLabels = new string[0];
        public string[] SendClassHints = new string[0];
        public string[] SendSvgPaths = new string[0];
        public bool EnterSends = false;
        /// <summary>登录页 URL 片段：当前地址包含任一片段即视为「停在登录页」（不区分大小写）。</summary>
        public string[] LoginMarkers = new string[0];
        public string VerifyUrlRegex = "";
        public string PrefillParam = "";
        public bool Upload = false;

        /// <summary>是否是「自定义」服务方（地址来自配置里的 ChatUrl）。</summary>
        public bool IsCustom
        {
            get { return string.Equals(Id, WebProviders.CustomId, StringComparison.OrdinalIgnoreCase); }
        }

        /// <summary>入口 URL 的 authority（CDP 连接时按它找目标页）。</summary>
        public string PrimaryAuthority
        {
            get
            {
                Uri uri;
                if (Uri.TryCreate(Url, UriKind.Absolute, out uri))
                {
                    return uri.GetLeftPart(UriPartial.Authority);
                }
                return Url;
            }
        }

        /// <summary>当前地址是否属于本服务方（按 Origins 后缀匹配）。</summary>
        public bool MatchesUrl(string url)
        {
            if (string.IsNullOrEmpty(url))
            {
                return false;
            }
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                return false;
            }
            string host = uri.Host.ToLowerInvariant();
            for (int i = 0; i < Origins.Length; i++)
            {
                string origin = (Origins[i] == null ? "" : Origins[i]).Trim().ToLowerInvariant();
                if (origin.Length == 0)
                {
                    continue;
                }
                if (host == origin || host.EndsWith("." + origin, StringComparison.Ordinal))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 当前地址是不是该站点的登录页（URL 里含 LoginMarkers 任一片段）。
        /// 登录页说明用户还没登录，注入/发送必然失败，调用方据此给出「请先登录」的提示。
        /// </summary>
        public bool IsLoginUrl(string url)
        {
            if (string.IsNullOrEmpty(url))
            {
                return false;
            }
            string text = url.ToLowerInvariant();
            for (int i = 0; i < LoginMarkers.Length; i++)
            {
                string marker = (LoginMarkers[i] == null ? "" : LoginMarkers[i]).Trim().ToLowerInvariant();
                if (marker.Length > 0 && text.IndexOf(marker, StringComparison.Ordinal) >= 0)
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 带 URL 预填的提问地址。不支持预填的站点直接返回入口 URL
        /// （DeepSeek 的 chat_url_prefill 只认 q/prompt/mode/search/thinking，autosend=1 无效）。
        /// </summary>
        public string BuildAskUrl(string prompt)
        {
            if (string.IsNullOrEmpty(PrefillParam))
            {
                return Url;
            }
            string separator = Url.IndexOf('?') >= 0 ? "&" : "?";
            return Url + separator + PrefillParam + "=" + Uri.EscapeDataString(prompt == null ? "" : prompt);
        }
    }

    /// <summary>
    /// 网页版服务方注册表：6 家预设（DeepSeek / 千问 / 豆包 / ChatGPT / Gemini / Grok）+ 自定义。
    ///
    /// 兼容性约定（IPC 协议 v2 的增量）：
    ///   - 请求里不带 provider 字段时，服务端按本机配置的当前服务方处理（旧版 DSH 插件
    ///     2.1.1 不传字段，升级桌面端后行为与升级前一致；新版插件总是显式带 provider）；
    ///   - 配置里没有 WebProvider 的旧版本，按 ChatUrl 推断：能对上某家预设的域名就算那家，
    ///     否则算 custom（实际用的是 ChatUrl）。
    ///   - 未知 id 一律回退 custom，不静默换成别的站点。
    /// </summary>
    public static class WebProviders
    {
        public const string DefaultId = "deepseek";
        public const string CustomId = "custom";
        public const string DefaultUrl = "https://chat.deepseek.com/";

        private static readonly List<WebProvider> Registry = BuildRegistry();

        /// <summary>6 家预设（不含 custom）。顺序就是设置页下拉的顺序。</summary>
        public static List<WebProvider> All
        {
            get { return Registry; }
        }

        /// <summary>默认服务方：DeepSeek（与旧版本的唯一行为保持一致）。</summary>
        public static WebProvider DefaultProvider
        {
            get { return Registry[0]; }
        }

        private static List<WebProvider> BuildRegistry()
        {
            List<WebProvider> list = new List<WebProvider>();
            list.Add(BuildDeepSeek());
            list.Add(BuildQwen());
            list.Add(BuildDoubao());
            list.Add(BuildChatGpt());
            list.Add(BuildGemini());
            list.Add(BuildGrok());
            return list;
        }

        // ---------- 各服务方预设 ----------
        // 说明：除 DeepSeek 外，其余站点按「最佳猜测 + 通用兜底」实现 —— 选择器尽力贴近
        // 公开页面结构，找不到就退到通用规则（可见 textarea/contenteditable/role=textbox、
        // 发送文案、输入框附近最后一个纯图标按钮）。实机校准只需改这里的字符串。

        private static WebProvider BuildDeepSeek()
        {
            WebProvider provider = new WebProvider();
            provider.Id = "deepseek";
            provider.Name = "DeepSeek";
            provider.Url = DefaultUrl;
            provider.Origins = new string[] { "chat.deepseek.com", "deepseek.com" };
            // 保持改造前的查找顺序：search textarea → textarea → contenteditable → 各种 data-testid。
            provider.ComposerSelectors = new string[]
            {
                "textarea[name=\"search\"]",
                "textarea",
                "div[contenteditable=\"true\"]",
                "p[contenteditable=\"true\"]",
                "[contenteditable=\"true\"]",
                "[role=\"textbox\"]",
                "[data-testid=\"chat-input\"] textarea",
                "[data-testid=\"chat-input\"] [contenteditable=\"true\"]",
                "textarea[data-testid]",
                "[data-testid*=\"input\"] textarea",
                "[data-testid*=\"input\"] [contenteditable=\"true\"]",
                "[data-testid=\"chat-input\"]"
            };
            // 实测（Edge 156 + chat.deepseek.com 2026-11）页面上唯一命中，且不依赖图标长什么样。
            provider.SendClassHints = new string[] { "ds-button--primary", "ds-button--circle" };
            provider.SendSvgPaths = new string[] { "M8.3125" };
            // 主路径仍是点击发送；Enter 只作「点不到按钮」时的兜底，保持改造前行为。
            provider.EnterSends = true;
            // 登录页 URL 片段：命中就提示「请先在窗口里登录」（登录态保存在浏览器 profile）。
            provider.LoginMarkers = new string[] { "sign_in", "signin", "login" };
            provider.VerifyUrlRegex = "^https?://chat\\.deepseek\\.com/";
            provider.PrefillParam = "q";
            provider.Upload = true;
            return provider;
        }

        private static WebProvider BuildQwen()
        {
            WebProvider provider = new WebProvider();
            provider.Id = "qwen";
            provider.Name = "千问 Qwen";
            provider.Url = "https://www.qianwen.com/";
            provider.Origins = new string[]
            {
                "www.qianwen.com", "qianwen.com", "qianwen.aliyun.com",
                "chat.qwen.ai", "tongyi.aliyun.com", "tongyi.com"
            };
            // 输入框/发送按钮都按通用兜底（发现候选后可用 --probe qwen 校准）。
            provider.SendAriaLabels = new string[] { "发送", "Send", "Submit" };
            provider.EnterSends = true;
            provider.LoginMarkers = new string[] { "login", "signin", "passport", "sso" };
            provider.VerifyUrlRegex = "^https?://((www\\.)?qianwen\\.com|qianwen\\.aliyun\\.com|chat\\.qwen\\.ai|tongyi\\.aliyun\\.com|(www\\.)?tongyi\\.com)/";
            provider.Upload = true;
            return provider;
        }

        private static WebProvider BuildDoubao()
        {
            WebProvider provider = new WebProvider();
            provider.Id = "doubao";
            provider.Name = "豆包 Doubao";
            provider.Url = "https://www.doubao.com/chat/";
            provider.Origins = new string[] { "www.doubao.com", "doubao.com" };
            provider.SendAriaLabels = new string[] { "发送", "Send", "Submit" };
            provider.EnterSends = true;
            provider.LoginMarkers = new string[] { "login", "signin", "passport", "sso" };
            provider.VerifyUrlRegex = "^https?://(www\\.)?doubao\\.com/";
            provider.Upload = true;
            return provider;
        }

        private static WebProvider BuildChatGpt()
        {
            WebProvider provider = new WebProvider();
            provider.Id = "chatgpt";
            provider.Name = "ChatGPT";
            provider.Url = "https://chatgpt.com/";
            provider.Origins = new string[] { "chatgpt.com", "chat.openai.com" };
            provider.ComposerSelectors = new string[]
            {
                "#prompt-textarea",
                "textarea#prompt-textarea",
                "div#prompt-textarea[contenteditable=\"true\"]"
            };
            provider.SendSelectors = new string[]
            {
                "button[data-testid=\"send-button\"]",
                "button#composer-submit-button"
            };
            provider.SendAriaLabels = new string[] { "Send prompt", "Send message", "发送" };
            provider.EnterSends = true;
            provider.LoginMarkers = new string[] { "auth0", "/auth/", "login", "signin" };
            provider.VerifyUrlRegex = "^https?://(chatgpt\\.com|chat\\.openai\\.com)/";
            provider.Upload = true;
            return provider;
        }

        private static WebProvider BuildGemini()
        {
            WebProvider provider = new WebProvider();
            provider.Id = "gemini";
            provider.Name = "Gemini";
            provider.Url = "https://gemini.google.com/app";
            provider.Origins = new string[] { "gemini.google.com" };
            provider.ComposerSelectors = new string[]
            {
                "rich-textarea .ql-editor",
                ".ql-editor[contenteditable=\"true\"]",
                "rich-textarea [contenteditable=\"true\"]"
            };
            provider.SendSelectors = new string[]
            {
                "button[aria-label*=\"Send\"]",
                "button.send-button",
                "[class*=\"send-button\"]"
            };
            provider.SendAriaLabels = new string[] { "Send message", "Send", "发送" };
            provider.EnterSends = true;
            // Gemini 未登录会被重定向到 Google 账号页（accounts.google.com/ServiceLogin）。
            provider.LoginMarkers = new string[] { "accounts.google.com", "servicelogin", "signin", "login" };
            provider.VerifyUrlRegex = "^https?://gemini\\.google\\.com/";
            provider.Upload = true;
            return provider;
        }

        private static WebProvider BuildGrok()
        {
            WebProvider provider = new WebProvider();
            provider.Id = "grok";
            provider.Name = "Grok";
            provider.Url = "https://grok.com/";
            provider.Origins = new string[] { "grok.com", "x.com" };
            provider.ComposerSelectors = new string[]
            {
                "textarea[aria-label]",
                "textarea"
            };
            provider.SendSelectors = new string[]
            {
                "button[aria-label=\"Submit\"]",
                "button[type=\"submit\"]",
                "[aria-label=\"Submit\"]"
            };
            provider.SendAriaLabels = new string[] { "Submit", "发送" };
            provider.EnterSends = true;
            provider.LoginMarkers = new string[] { "login", "signin", "i/flow" };
            provider.VerifyUrlRegex = "^https?://(grok\\.com|x\\.com)/";
            provider.Upload = true;
            return provider;
        }

        // ---------- 查询 / 解析 ----------

        /// <summary>按 id 取预设；custom 或未知 id 返回 null。</summary>
        public static WebProvider Get(string id)
        {
            return FindPreset(id);
        }

        /// <summary>是否是合法 id（6 家预设或 custom）。</summary>
        public static bool IsKnown(string id)
        {
            if (string.IsNullOrEmpty(id))
            {
                return false;
            }
            if (string.Equals(id.Trim(), CustomId, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            return FindPreset(id) != null;
        }

        /// <summary>支持的 id 列表（健康检查/诊断用，含 custom）。</summary>
        public static string[] Ids()
        {
            string[] ids = new string[Registry.Count + 1];
            for (int i = 0; i < Registry.Count; i++)
            {
                ids[i] = Registry[i].Id;
            }
            ids[Registry.Count] = CustomId;
            return ids;
        }

        /// <summary>把配置里的 id 规整成合法值：预设原样（小写）、custom 原样、未知 → custom。</summary>
        public static string NormalizeId(string id)
        {
            string value = (id == null ? "" : id).Trim();
            if (value.Length == 0)
            {
                return DefaultId;
            }
            if (string.Equals(value, CustomId, StringComparison.OrdinalIgnoreCase))
            {
                return CustomId;
            }
            WebProvider preset = FindPreset(value);
            return preset == null ? CustomId : preset.Id;
        }

        /// <summary>
        /// 旧配置迁移：没有 WebProvider 字段时按 ChatUrl 推断服务方。
        /// 能对上某家预设的域名（例如旧配置只是少了结尾斜杠）就算那家，否则算 custom。
        /// </summary>
        public static string InferLegacyProvider(string chatUrl)
        {
            string url = (chatUrl == null ? "" : chatUrl).Trim();
            if (url.Length == 0)
            {
                return DefaultId;
            }
            for (int i = 0; i < Registry.Count; i++)
            {
                if (Registry[i].MatchesUrl(url))
                {
                    return Registry[i].Id;
                }
            }
            return CustomId;
        }

        /// <summary>
        /// 取实际使用的服务方：空 id → DeepSeek；预设 → 预设配置；custom → 用 chatUrl 构造；
        /// 未知 id → 回退 custom（保留用户配置的地址，不静默换成别的站点）。
        /// </summary>
        public static WebProvider Resolve(string id, string chatUrl)
        {
            string value = (id == null ? "" : id).Trim();
            if (value.Length == 0)
            {
                return DefaultProvider;
            }
            WebProvider preset = FindPreset(value);
            if (preset != null)
            {
                return preset;
            }
            return BuildCustom(chatUrl);
        }

        /// <summary>按配置解析当前服务方（配置里的 WebProvider + ChatUrl）。</summary>
        public static WebProvider FromConfig(AppConfig config)
        {
            if (config == null)
            {
                return DefaultProvider;
            }
            return Resolve(config.WebProvider, config.ChatUrl);
        }

        /// <summary>自定义服务方：地址取配置里的 ChatUrl，选择器全部走通用兜底。</summary>
        public static WebProvider BuildCustom(string chatUrl)
        {
            string url = (chatUrl == null ? "" : chatUrl).Trim();
            if (!IsHttpUrl(url))
            {
                url = DefaultUrl;
            }
            WebProvider provider = new WebProvider();
            provider.Id = CustomId;
            provider.Name = "自定义";
            provider.Url = url;
            string host = HostOf(url);
            provider.Origins = host.Length == 0 ? new string[0] : new string[] { host };
            provider.SendAriaLabels = new string[] { "发送", "Send", "Submit" };
            // 未知站点不敢用 Enter 自动发送（可能只是换行），只认发送按钮。
            provider.EnterSends = false;
            provider.Upload = false;
            return provider;
        }

        private static WebProvider FindPreset(string id)
        {
            string value = (id == null ? "" : id).Trim();
            if (value.Length == 0)
            {
                return null;
            }
            for (int i = 0; i < Registry.Count; i++)
            {
                if (string.Equals(Registry[i].Id, value, StringComparison.OrdinalIgnoreCase))
                {
                    return Registry[i];
                }
            }
            return null;
        }

        private static bool IsHttpUrl(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                return false;
            }
            return uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
        }

        private static string HostOf(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                return "";
            }
            return uri.Host.ToLowerInvariant();
        }
    }
}
