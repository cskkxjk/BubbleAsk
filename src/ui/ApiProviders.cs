using System;
using System.Collections.Generic;

namespace BubbleAsk
{
    /// <summary>一个 OpenAI 兼容的服务方预设。用户也可以选 custom 自己填地址和模型。</summary>
    public class ApiProvider
    {
        public string Id;
        public string Name;
        public string BaseUrl;
        public string Model;
        public bool NeedsKey;
        public string Note;

        public ApiProvider(string id, string name, string baseUrl, string model, bool needsKey, string note)
        {
            Id = id;
            Name = name;
            BaseUrl = baseUrl;
            Model = model;
            NeedsKey = needsKey;
            Note = note;
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
                "https://api.deepseek.com", "deepseek-chat", true,
                "deepseek-chat 通用；deepseek-reasoner 会先给推理过程"));
            Items.Add(new ApiProvider("openai", "OpenAI",
                "https://api.openai.com", "gpt-4o-mini", true,
                "需要能直连 api.openai.com"));
            Items.Add(new ApiProvider("siliconflow", "硅基流动",
                "https://api.siliconflow.cn", "deepseek-ai/DeepSeek-V3", true,
                "国内中转，模型名以控制台为准"));
            Items.Add(new ApiProvider("ollama", "本地 Ollama",
                "http://127.0.0.1:11434/v1", "llama3.1", false,
                "本机跑模型，key 随便填或留空"));
            Items.Add(new ApiProvider(CustomId, "自定义",
                "", "", false,
                "自己填接口地址与模型名"));
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
