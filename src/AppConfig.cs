using System;
using System.Collections.Generic;
using System.IO;

namespace BubbleAsk
{
    /// <summary>应用配置。字段全部有默认值，缺字段的旧配置也能正常加载。</summary>
    public class AppConfig
    {
        public string ChatUrl = "https://chat.deepseek.com/";
        public string PromptTemplate = "什么是%s";
        public bool AutoSend = true;
        public int MaxChars = 2000;

        public string HotkeySummon = "Ctrl+Alt+D";
        public string HotkeyAsk = "Ctrl+Alt+Q";
        public string HotkeyShot = "Ctrl+Alt+A";

        public int WindowWidth = 480;
        public int WindowHeight = 720;
        public int CdpPort = 9333;
        public string EdgePath = "";
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

        public int BubbleWidth = 460;
        public int BubbleMaxHeight = 560;

        public bool StartWithWindows = false;
        public bool ShowBubble = true;

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

        public string EffectiveProfileDir
        {
            get { return string.IsNullOrEmpty(ProfileDir) ? DefaultProfileDir : ProfileDir; }
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
                config.PromptTemplate = Json.GetString(data, "PromptTemplate", config.PromptTemplate);
                config.AutoSend = Json.GetBool(data, "AutoSend", config.AutoSend);
                config.MaxChars = Json.GetInt(data, "MaxChars", config.MaxChars);
                config.HotkeySummon = Json.GetString(data, "HotkeySummon", config.HotkeySummon);
                config.HotkeyAsk = Json.GetString(data, "HotkeyAsk", config.HotkeyAsk);
                config.HotkeyShot = Json.GetString(data, "HotkeyShot", config.HotkeyShot);
                config.WindowWidth = Json.GetInt(data, "WindowWidth", config.WindowWidth);
                config.WindowHeight = Json.GetInt(data, "WindowHeight", config.WindowHeight);
                config.CdpPort = Json.GetInt(data, "CdpPort", config.CdpPort);
                config.EdgePath = Json.GetString(data, "EdgePath", config.EdgePath);
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
                config.BubbleWidth = Json.GetInt(data, "BubbleWidth", config.BubbleWidth);
                config.BubbleMaxHeight = Json.GetInt(data, "BubbleMaxHeight", config.BubbleMaxHeight);
                config.StartWithWindows = Json.GetBool(data, "StartWithWindows", config.StartWithWindows);
                config.ShowBubble = Json.GetBool(data, "ShowBubble", config.ShowBubble);
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
                data["PromptTemplate"] = PromptTemplate;
                data["AutoSend"] = AutoSend;
                data["MaxChars"] = MaxChars;
                data["HotkeySummon"] = HotkeySummon;
                data["HotkeyAsk"] = HotkeyAsk;
                data["HotkeyShot"] = HotkeyShot;
                data["WindowWidth"] = WindowWidth;
                data["WindowHeight"] = WindowHeight;
                data["CdpPort"] = CdpPort;
                data["EdgePath"] = EdgePath;
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
                data["BubbleWidth"] = BubbleWidth;
                data["BubbleMaxHeight"] = BubbleMaxHeight;
                data["StartWithWindows"] = StartWithWindows;
                data["ShowBubble"] = ShowBubble;
                File.WriteAllText(path, Json.Stringify(data));
            }
            catch (Exception error)
            {
                Log.Error("保存配置失败", error);
            }
        }
    }
}
