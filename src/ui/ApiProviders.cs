using System;
using System.Collections.Generic;

namespace BubbleAsk
{
    /// <summary>一个 OpenAI 兼容的服务方预设。用户也可以选 custom 自己填地址与模型名。</summary>
    public class ApiProvider
    {
        public string Id;
        public string Name;
        public string BaseUrl;
        public string Model;
        public bool NeedsKey;

        public ApiProvider(string id, string name, string baseUrl, string model, bool needsKey)
        {
            Id = id;
            Name = name;
            BaseUrl = baseUrl;
            Model = model;
            NeedsKey = needsKey;
        }
    }

    /// <summary>内置的服务方清单。全部走 OpenAI 兼容的 /chat/completions。</summary>
    public static class ApiProviders
    {
        public const string CustomId = "custom";

        private static readonly List<ApiProvider> Items = new List<ApiProvider>();

        static ApiProviders()
        {
            Items.Add(new ApiProvider("deepseek", "DeepSeek 官方",
                "https://api.deepseek.com", "deepseek-chat", true));
            Items.Add(new ApiProvider("openai", "OpenAI",
                "https://api.openai.com", "gpt-4o-mini", true));
            Items.Add(new ApiProvider("siliconflow", "硅基流动",
                "https://api.siliconflow.cn", "deepseek-ai/DeepSeek-V3", true));
            Items.Add(new ApiProvider("ollama", "本地 Ollama",
                "http://127.0.0.1:11434/v1", "llama3.1", false));
            Items.Add(new ApiProvider(CustomId, "自定义",
                "", "", false));
        }

        public static List<ApiProvider> All
        {
            get { return Items; }
        }

        /// <summary>按 id 找预设，找不到就当自定义。</summary>
        public static ApiProvider Resolve(string id)
        {
            string wanted = string.IsNullOrEmpty(id) ? "deepseek" : id.Trim();
            for (int i = 0; i < Items.Count; i++)
            {
                if (string.Equals(Items[i].Id, wanted, StringComparison.OrdinalIgnoreCase))
                {
                    return Items[i];
                }
            }
            for (int i = 0; i < Items.Count; i++)
            {
                if (Items[i].Id == CustomId)
                {
                    return Items[i];
                }
            }
            return Items[0];
        }

        /// <summary>设置界面的下拉项。</summary>
        public static string[] DisplayNames()
        {
            string[] names = new string[Items.Count];
            for (int i = 0; i < Items.Count; i++)
            {
                names[i] = Items[i].Name;
            }
            return names;
        }

        public static int IndexOf(string id)
        {
            ApiProvider provider = Resolve(id);
            for (int i = 0; i < Items.Count; i++)
            {
                if (string.Equals(Items[i].Id, provider.Id, StringComparison.OrdinalIgnoreCase))
                {
                    return i;
                }
            }
            return 0;
        }
    }
}
