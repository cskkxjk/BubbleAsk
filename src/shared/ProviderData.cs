using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;

namespace BubbleAsk
{
    /// <summary>
    /// 服务方数据的唯一真源读取器。
    ///
    /// 真源是仓库根的 `shared/providers.json`，编译时以**内嵌资源**打进 exe，
    /// 运行时用 System.Web.Extensions 的 JavaScriptSerializer 解析 —— 因此仍然是单 exe、
    /// 不需要额外文件，也不需要生成 C# 代码。
    ///
    /// 为什么这样做：同一份定义还要给 Chrome 扩展和 DSH 插件用（它们是 JS，由
    /// `tools/gen-providers.mjs` 生成本端数据模块）。以前三处各写一遍，靠人工同步。
    ///
    /// overrides 语义：真源里每家可带 `overrides.<host>`，**只覆盖它列出的字段**。
    /// 桌面端读 host=desktop（目前没有桌面端专属覆盖）。真实存在的行为差异
    /// （如 DeepSeek 在扩展端不用合成 Enter）就写在真源里，而不是散落在两套实现中。
    /// </summary>
    internal static class ProviderData
    {
        /// <summary>内嵌资源名：build.ps1 里用 /resource:...,BubbleAsk.providers.json 指定。</summary>
        internal const string ResourceName = "BubbleAsk.providers.json";

        private static Dictionary<string, object> _root;

        private static Dictionary<string, object> Root
        {
            get
            {
                if (_root == null)
                {
                    _root = Load();
                }
                return _root;
            }
        }

        private static Dictionary<string, object> Load()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream(ResourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException(
                        "缺少内嵌资源 " + ResourceName + "（build.ps1 的 /resource 参数是否漏了？）");
                }
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    // 复用项目自带的 Json 封装（同一个 serializer、同样的上限与容错），
                    // 不再单独 new 一个，避免两套解析路径行为不一致。
                    Dictionary<string, object> parsed = Json.ParseObject(json);
                    if (parsed == null || parsed.Count == 0)
                    {
                        throw new InvalidOperationException("providers.json 解析结果为空");
                    }
                    return parsed;
                }
            }
        }

        /// <summary>默认服务方 id（真源 defaultId，缺省 deepseek）。</summary>
        internal static string DefaultId
        {
            get { return Text(Root, "defaultId", "deepseek"); }
        }

        /// <summary>自定义服务方 id（真源 customId，缺省 custom）。</summary>
        internal static string CustomId
        {
            get { return Text(Root, "customId", "custom"); }
        }

        /// <summary>通用输入框兜底选择器。</summary>
        internal static string[] GenericComposerSelectors
        {
            get { return Strings(Generic(), "composerSelectors"); }
        }

        /// <summary>通用发送按钮文案兜底。</summary>
        internal static string[] GenericSendAriaLabels
        {
            get { return Strings(Generic(), "sendAriaLabels"); }
        }

        /// <summary>真源里的 6 家预设（未应用任何 overrides，按真源顺序）。</summary>
        internal static List<Dictionary<string, object>> Providers()
        {
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            object raw;
            if (!Root.TryGetValue("providers", out raw))
            {
                return list;
            }
            List<object> items = Items(raw);
            for (int i = 0; i < items.Count; i++)
            {
                Dictionary<string, object> item = items[i] as Dictionary<string, object>;
                if (item != null)
                {
                    list.Add(item);
                }
            }
            return list;
        }

        /// <summary>
        /// 把解析出来的 JSON 数组统一成 List&lt;object&gt;。
        ///
        /// 注意：.NET Framework 的 JavaScriptSerializer 对数组返回的是
        /// **ArrayList** 而不是 object[]（实测踩过：直接 `as object[]` 会得到 null，
        /// 于是注册表读成空列表）。这里两种都认，其它 IEnumerable 兜底。
        /// </summary>
        private static List<object> Items(object value)
        {
            List<object> list = new List<object>();
            if (value == null || value is string)
            {
                return list;
            }
            object[] array = value as object[];
            if (array != null)
            {
                list.AddRange(array);
                return list;
            }
            IEnumerable sequence = value as IEnumerable;
            if (sequence == null)
            {
                return list;
            }
            foreach (object item in sequence)
            {
                list.Add(item);
            }
            return list;
        }

        /// <summary>取某家在指定宿主上的最终定义（基础定义 + overrides[host]）。</summary>
        internal static Dictionary<string, object> Resolve(Dictionary<string, object> provider, string host)
        {
            Dictionary<string, object> merged = new Dictionary<string, object>(provider);
            object overridesRaw;
            if (!provider.TryGetValue("overrides", out overridesRaw))
            {
                return merged;
            }
            Dictionary<string, object> overrides = overridesRaw as Dictionary<string, object>;
            if (overrides == null)
            {
                return merged;
            }
            object patchRaw;
            if (!overrides.TryGetValue(host, out patchRaw))
            {
                return merged;
            }
            Dictionary<string, object> patch = patchRaw as Dictionary<string, object>;
            if (patch == null)
            {
                return merged;
            }
            foreach (KeyValuePair<string, object> pair in patch)
            {
                merged[pair.Key] = pair.Value;
            }
            return merged;
        }

        // ---------- 取值工具（对缺字段宽容，避免真源小改就崩） ----------

        internal static string Text(Dictionary<string, object> source, string key, string fallback)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null)
            {
                return fallback;
            }
            string text = value as string;
            return text == null ? fallback : text;
        }

        internal static string[] Strings(Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null)
            {
                return new string[0];
            }
            List<object> items = Items(value);
            List<string> list = new List<string>();
            for (int i = 0; i < items.Count; i++)
            {
                string item = items[i] as string;
                if (item != null)
                {
                    list.Add(item);
                }
            }
            return list.ToArray();
        }

        internal static bool Flag(Dictionary<string, object> source, string key, bool fallback)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null)
            {
                return fallback;
            }
            if (value is bool)
            {
                return (bool)value;
            }
            return fallback;
        }

        private static Dictionary<string, object> Generic()
        {
            object value;
            if (Root.TryGetValue("generic", out value))
            {
                Dictionary<string, object> generic = value as Dictionary<string, object>;
                if (generic != null)
                {
                    return generic;
                }
            }
            return new Dictionary<string, object>();
        }
    }
}
