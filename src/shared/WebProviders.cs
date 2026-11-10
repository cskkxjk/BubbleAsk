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
        /// <summary>默认服务方 id（真源 shared/providers.json 的 defaultId）。</summary>
        public static readonly string DefaultId = ProviderData.DefaultId;

        /// <summary>自定义服务方 id（真源 customId）。</summary>
        public static readonly string CustomId = ProviderData.CustomId;

        /// <summary>默认入口地址 = 第一家预设的 url，避免地址写两遍。</summary>
        public static readonly string DefaultUrl = FirstUrl();

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

        /// <summary>
        /// 从真源构建注册表。
        ///
        /// 数据全部来自 shared/providers.json（编译时内嵌）；本类只负责「怎么用」。
        /// 加站点或校准选择器请改真源并跑 tools/gen-providers.mjs，不要改这里。
        /// </summary>
        private static List<WebProvider> BuildRegistry()
        {
            List<WebProvider> list = new List<WebProvider>();
            List<Dictionary<string, object>> items = ProviderData.Providers();
            for (int i = 0; i < items.Count; i += 1)
            {
                list.Add(FromDictionary(ProviderData.Resolve(items[i], "desktop")));
            }
            if (list.Count == 0)
            {
                throw new InvalidOperationException("shared/providers.json 里没有任何服务方定义");
            }
            return list;
        }

        private static WebProvider FromDictionary(Dictionary<string, object> item)
        {
            WebProvider provider = new WebProvider();
            provider.Id = ProviderData.Text(item, "id", "");
            provider.Name = ProviderData.Text(item, "name", provider.Id);
            provider.Url = ProviderData.Text(item, "url", "");
            provider.Origins = ProviderData.Strings(item, "origins");
            provider.ComposerSelectors = ProviderData.Strings(item, "composerSelectors");
            provider.SendSelectors = ProviderData.Strings(item, "sendSelectors");
            provider.SendAriaLabels = ProviderData.Strings(item, "sendAriaLabels");
            provider.SendClassHints = ProviderData.Strings(item, "sendClassHints");
            provider.SendSvgPaths = ProviderData.Strings(item, "sendSvgPaths");
            provider.EnterSends = ProviderData.Flag(item, "enterSends", false);
            provider.LoginMarkers = ProviderData.Strings(item, "loginMarkers");
            provider.VerifyUrlRegex = ProviderData.Text(item, "verifyUrlRegex", "");
            provider.PrefillParam = ProviderData.Text(item, "prefillParam", "");
            provider.Upload = ProviderData.Flag(item, "upload", false);
            return provider;
        }

        private static string FirstUrl()
        {
            List<Dictionary<string, object>> items = ProviderData.Providers();
            if (items.Count == 0)
            {
                return "https://chat.deepseek.com/";
            }
            return ProviderData.Text(items[0], "url", "https://chat.deepseek.com/");
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
