using System;
using System.Collections.Generic;
using System.IO;

namespace BubbleAsk
{
    /// <summary>应用配置。字段全部有默认值，缺字段的旧配置也能正常加载。</summary>
    public class AppConfig
    {
        public string ChatUrl = WebProviders.DefaultUrl;
        /// <summary>
        /// 网页版服务方 id（见 WebProviders）：deepseek / qwen / doubao / chatgpt / gemini / grok / custom。
        /// 选 custom 时实际地址用 ChatUrl；预设服务方的地址由程序固定。
        /// </summary>
        public string WebProvider = WebProviders.DefaultId;
        public string PromptTemplate = "什么是%s";
        public bool AutoSend = true;
        public int MaxChars = 2000;

        public string HotkeySummon = "Ctrl+Alt+D";
        public string HotkeyAsk = "Ctrl+Alt+Q";
        public string HotkeyShot = "Ctrl+Alt+A";

        public int WindowWidth = 480;
        public int WindowHeight = 720;
        /// <summary>网页版小窗与 API 气泡共用的位置；-1 表示还没定过。</summary>
        public int WindowX = -1;
        public int WindowY = -1;
        public int CdpPort = 9333;

        /// <summary>浏览器 exe 路径。空着就自动检测（Edge → Chrome → 其它 Chromium 内核）。</summary>
        public string BrowserPath = "";

        public string ProfileDir = "";
        public bool TopMost = true;

        public string Mode = "web"; // web | api
        public string ShotPrompt = PromptBuilder.DefaultShotPrompt;

        public string ApiProvider = "deepseek";
        public string ApiBaseUrl = "https://api.deepseek.com";
        public string ApiKey = "";
        public string ApiModel = "deepseek-chat";
        public int ApiMaxTokens = 2048;
        public string ApiSystemPrompt = "你是一个简洁、准确的中文助手。回答控制在 300 字以内，除非我要求展开。";

        public bool StartWithWindows = false;

        public static string DataDir
        {
            get
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                return Path.Combine(appData, "BubbleAsk");
            }
        }

        public static string ConfigPath
        {
            get { return Path.Combine(DataDir, "config.json"); }
        }

        public static string LogPath
        {
            get { return Path.Combine(DataDir, "app.log"); }
        }

        public static string DefaultProfileDir
        {
            get { return Path.Combine(DataDir, "edge-profile"); }
        }

        /// <summary>
        /// 每个浏览器用各自的 profile 目录：不同内核的 profile 布局不通用，混用会打不开。
        /// Edge 保持老目录名 edge-profile，这样老用户的登录态不用重新登。
        /// </summary>
        public string EffectiveProfileDirFor(string browserId)
        {
            if (!string.IsNullOrEmpty(ProfileDir))
            {
                return ProfileDir;
            }
            if (string.IsNullOrEmpty(browserId) || string.Equals(browserId, "edge", StringComparison.OrdinalIgnoreCase))
            {
                return DefaultProfileDir;
            }
            return Path.Combine(DataDir, "profile-" + browserId);
        }

        public string EffectiveProfileDir
        {
            get { return EffectiveProfileDirFor("edge"); }
        }

        public static AppConfig Load()
        {
            return LoadFrom(ConfigPath);
        }

        public static AppConfig LoadFrom(string path)
        {
            AppConfig config = new AppConfig();
            try
            {
                if (!File.Exists(path))
                {
                    return config;
                }
                string json = File.ReadAllText(path);
                Dictionary<string, object> data = Json.ParseObject(json);
                if (data.Count == 0)
                {
                    return config;
                }
                config.ChatUrl = Json.GetString(data, "ChatUrl", config.ChatUrl);
                // 网页版服务方：旧配置没有这个字段，按 ChatUrl 推断（能对上某家预设的域名就算那家，
                // 否则算 custom，地址仍用 ChatUrl）。这比一律当 DeepSeek 更安全，也不会丢用户自定义地址。
                config.WebProvider = Json.GetString(data, "WebProvider", "");
                if (string.IsNullOrEmpty(config.WebProvider) || config.WebProvider.Trim().Length == 0)
                {
                    config.WebProvider = WebProviders.InferLegacyProvider(config.ChatUrl);
                }
                else
                {
                    // 未知 id 一律回退 custom，不静默换成别的站点。
                    config.WebProvider = WebProviders.NormalizeId(config.WebProvider);
                }
                config.PromptTemplate = Json.GetString(data, "PromptTemplate", config.PromptTemplate);
                config.AutoSend = Json.GetBool(data, "AutoSend", config.AutoSend);
                config.MaxChars = Json.GetInt(data, "MaxChars", config.MaxChars);
                config.HotkeySummon = Json.GetString(data, "HotkeySummon", config.HotkeySummon);
                config.HotkeyAsk = Json.GetString(data, "HotkeyAsk", config.HotkeyAsk);
                config.HotkeyShot = Json.GetString(data, "HotkeyShot", config.HotkeyShot);
                config.WindowWidth = Json.GetInt(data, "WindowWidth", config.WindowWidth);
                config.WindowHeight = Json.GetInt(data, "WindowHeight", config.WindowHeight);
                config.WindowX = Json.GetInt(data, "WindowX", config.WindowX);
                config.WindowY = Json.GetInt(data, "WindowY", config.WindowY);
                config.CdpPort = Json.GetInt(data, "CdpPort", config.CdpPort);
                // 老配置里这个字段叫 EdgePath，读一次做兼容；新写入一律用 BrowserPath。
                config.BrowserPath = Json.GetString(data, "BrowserPath", config.BrowserPath);
                if (string.IsNullOrEmpty(config.BrowserPath))
                {
                    config.BrowserPath = Json.GetString(data, "EdgePath", "");
                }
                config.ProfileDir = Json.GetString(data, "ProfileDir", config.ProfileDir);
                config.TopMost = Json.GetBool(data, "TopMost", config.TopMost);
                config.Mode = Json.GetString(data, "Mode", config.Mode);
                config.ShotPrompt = Json.GetString(data, "ShotPrompt", config.ShotPrompt);
                config.ApiProvider = Json.GetString(data, "ApiProvider", config.ApiProvider);
                config.ApiBaseUrl = Json.GetString(data, "ApiBaseUrl", config.ApiBaseUrl);
                config.ApiKey = Json.GetString(data, "ApiKey", config.ApiKey);
                config.ApiModel = Json.GetString(data, "ApiModel", config.ApiModel);
                config.ApiMaxTokens = Json.GetInt(data, "ApiMaxTokens", config.ApiMaxTokens);
                config.ApiSystemPrompt = Json.GetString(data, "ApiSystemPrompt", config.ApiSystemPrompt);
                config.StartWithWindows = Json.GetBool(data, "StartWithWindows", config.StartWithWindows);
            }
            catch (Exception error)
            {
                Log.Error("读取配置失败，使用默认值", error);
            }
            return config;
        }

        public void Save()
        {
            SaveTo(ConfigPath);
        }

        public void SaveTo(string path)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                Dictionary<string, object> data = new Dictionary<string, object>();
                data["ChatUrl"] = ChatUrl;
                data["WebProvider"] = WebProvider;
                data["PromptTemplate"] = PromptTemplate;
                data["AutoSend"] = AutoSend;
                data["MaxChars"] = MaxChars;
                data["HotkeySummon"] = HotkeySummon;
                data["HotkeyAsk"] = HotkeyAsk;
                data["HotkeyShot"] = HotkeyShot;
                data["WindowWidth"] = WindowWidth;
                data["WindowHeight"] = WindowHeight;
                data["WindowX"] = WindowX;
                data["WindowY"] = WindowY;
                data["CdpPort"] = CdpPort;
                data["BrowserPath"] = BrowserPath;
                data["ProfileDir"] = ProfileDir;
                data["TopMost"] = TopMost;
                data["Mode"] = Mode;
                data["ShotPrompt"] = ShotPrompt;
                data["ApiProvider"] = ApiProvider;
                data["ApiBaseUrl"] = ApiBaseUrl;
                data["ApiKey"] = ApiKey;
                data["ApiModel"] = ApiModel;
                data["ApiMaxTokens"] = ApiMaxTokens;
                data["ApiSystemPrompt"] = ApiSystemPrompt;
                data["StartWithWindows"] = StartWithWindows;
                File.WriteAllText(path, Json.Stringify(data));
            }
            catch (Exception error)
            {
                Log.Error("保存配置失败", error);
            }
        }
    }
}
