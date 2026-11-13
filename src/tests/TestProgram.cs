using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>无界面自测：编译成控制台 exe，跑完输出 PASS/FAIL 并用退出码汇报。</summary>
    internal static class TestProgram
    {
        private const int EmFormatRange = 0x0439;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CharRange
        {
            public int Min, Max;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FormatRange
        {
            public IntPtr Hdc;
            public IntPtr HdcTarget;
            public NativeRect Rect;
            public NativeRect PageRect;
            public CharRange Range;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, ref FormatRange lParam);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private static int _failures;

        [STAThread]
        private static int Main(string[] args)
        {
            // 开发用：用真实浏览器打开某个网页版服务方，输出候选 composer/发送按钮信息（JSON）。
            //   BubbleAsk.Tests.exe --probe deepseek
            if (args != null && args.Length > 0 && string.Equals(args[0], "--probe", StringComparison.OrdinalIgnoreCase))
            {
                return RunProbe(args.Length > 1 ? args[1] : WebProviders.DefaultId);
            }

            // 开发用：单独跑一次截图遮罩，把结果打到标准输出，方便脚本化验证。
            //   BubbleAsk.Tests.exe --capture
            if (args != null && args.Length > 0 && string.Equals(args[0], "--capture", StringComparison.OrdinalIgnoreCase))
            {
                string shot = ScreenCapture.CaptureInteractive();
                if (string.IsNullOrEmpty(shot))
                {
                    Console.WriteLine("CANCELLED");
                    return 2;
                }
                Console.WriteLine("SAVED " + shot + " " + new FileInfo(shot).Length);
                return 0;
            }

            // 开发用：跑一次 HTML 版气泡并截图（验证 WebView2 这条路真的能渲染）。
            //   BubbleAsk.Tests.exe --bubbleweb <outDir>
            if (args != null && args.Length > 0 && string.Equals(args[0], "--bubbleweb", StringComparison.OrdinalIgnoreCase))
            {
                return RunBubbleWeb(args.Length > 1 ? args[1] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "selftest"));
            }

            string outDir = args != null && args.Length > 0 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "selftest");
            Directory.CreateDirectory(outDir);

            // 自测里强制用原生气泡：DrawToBitmap 抓不到 WebView2 的内容，
            // 排版断言得在那套自绘界面上做。HTML 版另有独立的前端测试（见 docs 说明）。
            AnswerBubble.ForceNativeUi = true;
            // 离屏测试窗口的位置别写进用户配置
            AnswerBubble.PersistPosition = false;

            try
            {
                TestJson();
                TestPrompt();
                TestHotkeyParse();
                TestBrowsers();
                TestConfigRoundTrip();
                TestProviders();
                TestWebProviders();
                TestEndpoints();
                TestPayload(outDir);
                TestDeltaParsing();
                TestStreaming();
            TestStreamingMultiline();
                TestStreamingError();
                TestStreamErrorFrame();
                TestTruncationNotice();
                TestEmptyAnswer();
                TestTimeoutRecovery();
                TestApiChat();
                TestOffscreenForm(outDir);
                TestPlacement();
                TestBubble(outDir);
                TestIcon();
            }
            catch (Exception error)
            {
                Console.WriteLine("UNHANDLED");
                DumpException(error, 0);
                return 3;
            }

            Console.WriteLine(_failures == 0 ? "ALL PASS" : _failures + " FAILURE(S)");
            return _failures == 0 ? 0 : 1;
        }

        /// <summary>
        /// 把异常连同内部异常链打出来。
        ///
        /// 不能直接用 ex.ToString()：静态构造函数失败时它会抛「由于 Exception.ToString() 失败」，
        /// 反而把真正的原因藏起来（正是这个坑让人排查了一轮）。
        /// </summary>
        private static void DumpException(Exception error, int depth)
        {
            while (error != null && depth < 8)
            {
                Console.WriteLine("EXCEPTION[" + depth + "] " + error.GetType().FullName);
                Console.WriteLine("  message: " + error.Message);
                error = error.InnerException;
                depth += 1;
            }
        }

        private static void Check(string name, bool condition, string detail)
        {
            if (condition)
            {
                Console.WriteLine("PASS " + name);
            }
            else
            {
                _failures++;
                Console.WriteLine("FAIL " + name + (detail == null ? "" : " :: " + detail));
            }
        }

        /// <summary>
        /// --probe &lt;providerId&gt;：用真实浏览器打开该网页版服务方，把候选 composer/发送按钮信息
        /// 以 JSON 打到标准输出，供实机校准 WebProviders 里的选择器（不注入、不发送、不要求已登录）。
        /// 退出码：0 成功、1 浏览器/页面失败、2 参数错误。
        /// </summary>
        private static int RunProbe(string providerId)
        {
            string id = (providerId == null ? "" : providerId).Trim();
            if (!WebProviders.IsKnown(id))
            {
                Console.WriteLine("ERROR 未知的网页版服务方: " + id);
                Console.WriteLine("可用: " + string.Join(", ", WebProviders.Ids()));
                return 2;
            }
            AppConfig config = AppConfig.Load();
            WebProvider provider = WebProviders.Resolve(id, config.ChatUrl);
            Console.WriteLine("PROBE " + provider.Id + " " + provider.Url);
            ChatDriver driver = new ChatDriver(config);
            try
            {
                string json = driver.ProbeAsync(provider).GetAwaiter().GetResult();
                Console.WriteLine(json);
                return json != null && json.StartsWith("ERR:", StringComparison.Ordinal) ? 1 : 0;
            }
            catch (Exception error)
            {
                Console.WriteLine("ERROR " + error.Message);
                return 1;
            }
            finally
            {
                driver.Dispose();
            }
        }

        private static void TestJson()
        {
            Dictionary<string, object> data = Json.ParseObject("{\"a\":\"x\",\"b\":true,\"c\":12.5}");
            Check("json parse string", Json.GetString(data, "a", "") == "x", null);
            Check("json parse bool", Json.GetBool(data, "b", false), null);
            Check("json missing fallback", Json.GetString(data, "zzz", "def") == "def", null);

            List<object> items = Json.ParseArray("[{\"type\":\"page\",\"url\":\"https://chat.deepseek.com/\"}]");
            Check("json array length", items.Count == 1, "got " + items.Count);
            Dictionary<string, object> first = items.Count > 0 ? items[0] as Dictionary<string, object> : null;
            Check("json array item", first != null && Json.GetString(first, "type", "") == "page", null);
        }

        private static void TestPrompt()
        {
            Check("prompt default", PromptBuilder.Build("什么是%s", "闭包") == "什么是闭包", null);
            Check("prompt middle", PromptBuilder.Build("请解释%s的含义", "熵") == "请解释熵的含义", null);
            Check("prompt prefix only", PromptBuilder.Build("什么是", "熵") == "什么是熵", null);
            Check("prompt empty", PromptBuilder.Build("什么是%s", "   ") == "", null);
            Check("prompt null template", PromptBuilder.Build(null, "熵") == "什么是熵", null);

            Check("prompt free", PromptBuilder.BuildFree("这张截图里是什么？") == "这张截图里是什么？", null);
            Check("prompt free strips placeholder", PromptBuilder.BuildFree("%s 是什么") == "是什么", PromptBuilder.BuildFree("%s 是什么"));
            Check("prompt free default", PromptBuilder.BuildFree("  ") == "这张截图里是什么？请解释一下。", PromptBuilder.BuildFree("  "));

            string normalized = PromptBuilder.Normalize("  第一行\n\n  第二行\t  ", 100);
            Check("normalize whitespace", normalized == "第一行 第二行", "got [" + normalized + "]");

            string longText = new string('a', 1000);
            string truncated = PromptBuilder.Normalize(longText, 100);
            Check("normalize truncates", truncated.Length <= 110 && truncated.Length > 50, "len=" + truncated.Length);

            // 用户自己写的问题：问题在后、材料在前；空问题返回空串让调用方回退模板。
            string own = PromptBuilder.BuildWithQuestion("这跟上面矛盾吗？", "分布式系统没有银弹");
            Check("question prompt keeps text", own.Contains("分布式系统没有银弹"), own);
            Check("question prompt puts question last", own.TrimEnd().EndsWith("这跟上面矛盾吗？"), own);
            Check("question prompt empty question", PromptBuilder.BuildWithQuestion("   ", "任意") == "", null);
            Check("question prompt without text", PromptBuilder.BuildWithQuestion("解释一下", null) == "【我的问题】\r\n解释一下" || PromptBuilder.BuildWithQuestion("解释一下", null) == "【我的问题】\n解释一下", PromptBuilder.BuildWithQuestion("解释一下", null));
        }

        private static void TestHotkeyParse()
        {
            uint modifiers;
            uint key;
            bool ok = HotkeyManager.TryParse("Ctrl+Alt+D", out modifiers, out key);
            Check("hotkey parse ctrl+alt+d", ok && key == (uint)Keys.D && (modifiers & 0x0002) != 0 && (modifiers & 0x0001) != 0,
                "ok=" + ok + " key=" + key + " mods=" + modifiers);

            ok = HotkeyManager.TryParse("Ctrl+Shift+F1", out modifiers, out key);
            Check("hotkey parse f1", ok && key == (uint)Keys.F1, "ok=" + ok + " key=" + key);

            ok = HotkeyManager.TryParse("Alt+", out modifiers, out key);
            Check("hotkey parse invalid", !ok, null);

            // 不带修饰键的普通按键会全局抢键（打 a 就触发提问），必须拒绝；F1-F24 放行。
            ok = HotkeyManager.TryParse("A", out modifiers, out key);
            Check("hotkey bare letter rejected", !ok, "ok=" + ok);
            ok = HotkeyManager.TryParse("5", out modifiers, out key);
            Check("hotkey bare digit rejected", !ok, "ok=" + ok);
            ok = HotkeyManager.TryParse("F5", out modifiers, out key);
            Check("hotkey bare f5 allowed", ok && key == (uint)Keys.F5, "ok=" + ok + " key=" + key);
        }

        private static void TestBrowsers()
        {
            List<BrowserInfo> all = BrowserLocator.DetectAll();
            Check("browser detect returns list", all != null, null);

            bool valid = true;
            string detail = "";
            List<string> names = new List<string>();
            for (int i = 0; i < all.Count; i++)
            {
                BrowserInfo item = all[i];
                names.Add(item.DisplayName);
                if (string.IsNullOrEmpty(item.ExePath) || !File.Exists(item.ExePath)
                    || string.IsNullOrEmpty(item.ExeName) || string.IsNullOrEmpty(item.DisplayName)
                    || string.IsNullOrEmpty(item.Id))
                {
                    valid = false;
                    detail = detail + item.Id + " ";
                }
            }
            Check("browser entries valid", valid, detail);
            Console.WriteLine("检测到浏览器 " + all.Count + " 个: " +
                              (names.Count == 0 ? "（无）" : string.Join("、", names.ToArray())));

            // 反查：exe 名字要能映射回稳定 id（设置页和 profile 目录都靠它）。
            Check("browser describe msedge", BrowserLocator.Describe(@"C:\x\msedge.exe").Id == "edge",
                BrowserLocator.Describe(@"C:\x\msedge.exe").Id);
            Check("browser describe chrome", BrowserLocator.Describe(@"C:\x\chrome.exe").Id == "chrome",
                BrowserLocator.Describe(@"C:\x\chrome.exe").Id);
            Check("browser describe brave", BrowserLocator.Describe(@"C:\x\brave.exe").Id == "brave",
                BrowserLocator.Describe(@"C:\x\brave.exe").Id);
            Check("browser describe unknown", BrowserLocator.Describe(@"C:\x\weird.exe").Id == "custom",
                BrowserLocator.Describe(@"C:\x\weird.exe").Id);

            if (all.Count > 0)
            {
                string explicitPath = BrowserLocator.Resolve(all[0].ExePath).ExePath;
                Check("browser resolve explicit", string.Equals(explicitPath, all[0].ExePath, StringComparison.OrdinalIgnoreCase),
                    explicitPath);
                string autoPath = BrowserLocator.Resolve("").ExePath;
                Check("browser resolve auto", string.Equals(autoPath, all[0].ExePath, StringComparison.OrdinalIgnoreCase),
                    autoPath);
            }
            else
            {
                Check("browser resolve missing", BrowserLocator.Resolve("") == null, null);
            }

            // 不同浏览器必须用不同 profile 目录，否则登录态/内核数据会互相踩。
            AppConfig config = new AppConfig();
            string edgeDir = config.EffectiveProfileDirFor("edge");
            string chromeDir = config.EffectiveProfileDirFor("chrome");
            Check("profile edge keeps legacy dir", edgeDir.EndsWith("edge-profile", StringComparison.OrdinalIgnoreCase), edgeDir);
            Check("profile per browser", !string.Equals(edgeDir, chromeDir, StringComparison.OrdinalIgnoreCase), chromeDir);
            config.ProfileDir = @"D:\custom-profile";
            Check("profile override wins",
                config.EffectiveProfileDirFor("chrome") == @"D:\custom-profile", config.EffectiveProfileDirFor("chrome"));
        }

        private static void TestConfigRoundTrip()
        {
            string dir = Path.Combine(Path.GetTempPath(), "bubbleask-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string path = Path.Combine(dir, "config.json");

            AppConfig source = new AppConfig();
            source.PromptTemplate = "请解释%s";
            source.AutoSend = false;
            source.MaxChars = 1234;
            source.HotkeyAsk = "Ctrl+Alt+Q";
            source.WindowWidth = 520;
            source.CdpPort = 9444;
            source.ApiKey = "sk-test";
            source.Mode = "api";
            source.WebProvider = "gemini";
            source.ShotPrompt = "看图说话";
            source.ApiProvider = "ollama";
            source.ApiSystemPrompt = "你是测试助手";
            source.BrowserPath = @"C:\Browsers\chrome.exe";
            source.SaveTo(path);

            AppConfig loaded = AppConfig.LoadFrom(path);
            Check("config template", loaded.PromptTemplate == "请解释%s", loaded.PromptTemplate);
            Check("config bool", loaded.AutoSend == false, null);
            Check("config int", loaded.MaxChars == 1234 && loaded.CdpPort == 9444, loaded.MaxChars + "/" + loaded.CdpPort);
            Check("config string", loaded.HotkeyAsk == "Ctrl+Alt+Q" && loaded.ApiKey == "sk-test", null);
            Check("config mode", loaded.Mode == "api", loaded.Mode);
            Check("config shot prompt", loaded.ShotPrompt == "看图说话", loaded.ShotPrompt);
            Check("config provider", loaded.ApiProvider == "ollama", loaded.ApiProvider);
            Check("config system prompt", loaded.ApiSystemPrompt == "你是测试助手", loaded.ApiSystemPrompt);
            Check("config defaults kept", loaded.HotkeySummon == "Ctrl+Alt+D", loaded.HotkeySummon);
            Check("config browser path", loaded.BrowserPath == @"C:\Browsers\chrome.exe", loaded.BrowserPath);
            Check("config web provider", loaded.WebProvider == "gemini", loaded.WebProvider);

            // 老配置里只有 EdgePath，读的时候要能迁移到 BrowserPath。
            string legacy = Path.Combine(dir, "legacy.json");
            File.WriteAllText(legacy, "{\"EdgePath\":\"C:\\\\Old\\\\msedge.exe\"}");
            Check("config legacy edge path migrates", AppConfig.LoadFrom(legacy).BrowserPath == @"C:\Old\msedge.exe",
                AppConfig.LoadFrom(legacy).BrowserPath);

            // 老配置没有 WebProvider：能对上预设域名就算那家，否则算自定义（地址仍用 ChatUrl）。
            string legacyProvider = Path.Combine(dir, "legacy-provider.json");
            File.WriteAllText(legacyProvider, "{\"ChatUrl\":\"https://example.com/chat\"}");
            AppConfig migrated = AppConfig.LoadFrom(legacyProvider);
            Check("config web provider migrates custom",
                migrated.WebProvider == "custom" && migrated.ChatUrl == "https://example.com/chat",
                migrated.WebProvider + " / " + migrated.ChatUrl);

            string legacyDefault = Path.Combine(dir, "legacy-default.json");
            File.WriteAllText(legacyDefault, "{\"ChatUrl\":\"https://chat.deepseek.com/\"}");
            Check("config web provider migrates deepseek", AppConfig.LoadFrom(legacyDefault).WebProvider == "deepseek",
                AppConfig.LoadFrom(legacyDefault).WebProvider);

            string unknownProvider = Path.Combine(dir, "unknown-provider.json");
            File.WriteAllText(unknownProvider, "{\"WebProvider\":\"nope\"}");
            Check("config web provider unknown -> custom", AppConfig.LoadFrom(unknownProvider).WebProvider == "custom",
                AppConfig.LoadFrom(unknownProvider).WebProvider);

            try
            {
                Directory.Delete(dir, true);
            }
            catch
            {
            }
        }

        private static void TestProviders()
        {
            ApiProvider deepseek = ApiProviders.Resolve("deepseek");
            Check("provider deepseek", deepseek.BaseUrl == "https://api.deepseek.com" && deepseek.NeedsKey,
                deepseek.BaseUrl);

            Check("provider unknown -> custom", ApiProviders.Resolve("nope").Id == ApiProviders.CustomId,
                ApiProviders.Resolve("nope").Id);
            Check("provider empty -> deepseek", ApiProviders.Resolve("").Id == "deepseek", ApiProviders.Resolve("").Id);
            Check("provider index", ApiProviders.IndexOf("openai") == 1, ApiProviders.IndexOf("openai").ToString());
            Check("provider names", ApiProviders.DisplayNames().Length == ApiProviders.All.Count, null);
        }

        /// <summary>网页版服务方注册表：6 家预设 + 自定义解析 + 配置迁移 + 脚本生成。</summary>
        private static void TestWebProviders()
        {
            Check("web providers count", WebProviders.All.Count == 6, WebProviders.All.Count.ToString());
            Check("web provider default", WebProviders.DefaultProvider.Id == "deepseek"
                && WebProviders.DefaultId == "deepseek", WebProviders.DefaultProvider.Id);

            // 注册表必须来自真源（shared/providers.json），别处不应再有第二份。
            // 断言「真源能读出来、id 顺序一致、桌面端用的是基础定义」。
            List<Dictionary<string, object>> source = ProviderData.Providers();
            Check("provider source loads", source.Count == 6, source.Count.ToString());
            List<string> sourceIds = new List<string>();
            for (int i = 0; i < source.Count; i += 1)
            {
                sourceIds.Add(ProviderData.Text(source[i], "id", "?"));
            }
            Check("provider source order",
                string.Join(",", sourceIds.ToArray()) == "deepseek,qwen,doubao,chatgpt,gemini,grok",
                string.Join(",", sourceIds.ToArray()));

            // 全站关闭 Enter 兜底：找不到发送按钮就如实失败，交给用户自己回车或点按钮。
            // 这样两端行为一致，也不再依赖「可信按键 vs 合成事件」的可靠性差异。
            bool anyAutoEnter = false;
            for (int i = 0; i < WebProviders.All.Count; i += 1)
            {
                anyAutoEnter = anyAutoEnter || WebProviders.All[i].EnterSends;
            }
            Check("provider no auto enter anywhere", !anyAutoEnter, null);

            // overrides 机制本身仍要可用（为将来某个「只能回车提交」的站点保留），
            // 用内存里造的数据验证合并语义，不依赖真源当前是否有覆写。
            Dictionary<string, object> demoBase = new Dictionary<string, object>();
            demoBase["id"] = "demo";
            demoBase["enterSends"] = true;
            demoBase["upload"] = true;
            Dictionary<string, object> demoPatch = new Dictionary<string, object>();
            demoPatch["enterSends"] = false;
            Dictionary<string, object> demoOverrides = new Dictionary<string, object>();
            demoOverrides["extension"] = demoPatch;
            demoBase["overrides"] = demoOverrides;
            Dictionary<string, object> extendedView = ProviderData.Resolve(demoBase, "extension");
            Dictionary<string, object> plainView = ProviderData.Resolve(demoBase, "desktop");
            Check("provider overrides merge per host",
                ProviderData.Flag(extendedView, "enterSends", true) == false
                && ProviderData.Flag(plainView, "enterSends", false) == true
                && ProviderData.Flag(extendedView, "upload", false) == true, null);

            // 通用兜底也来自真源
            WebProvider deepseekBase = WebProviders.Get("deepseek");
            string[] genericComposer = ProviderData.GenericComposerSelectors;
            Check("provider generic composer from source",
                Array.IndexOf(genericComposer, "[role=\"textbox\"]") >= 0, string.Join(",", genericComposer));
            Check("provider generic send labels from source",
                Array.IndexOf(ProviderData.GenericSendAriaLabels, "提交") >= 0,
                string.Join(",", ProviderData.GenericSendAriaLabels));
            // 脚本里确实用上了真源的通用兜底（不是另写死一份）
            string stateScript = PageScripts.BuildStateScript(deepseekBase);
            Check("provider script uses source labels", stateScript.Contains("提交"), null);

            List<string> ids = new List<string>();
            bool complete = true;
            bool unique = true;
            for (int i = 0; i < WebProviders.All.Count; i++)
            {
                WebProvider item = WebProviders.All[i];
                complete = complete && item.Id.Length > 0 && item.Name.Length > 0
                    && item.Url.Length > 0 && item.Origins.Length > 0;
                unique = unique && ids.IndexOf(item.Id) < 0;
                ids.Add(item.Id);
            }
            Check("web providers complete", complete, string.Join(",", ids.ToArray()));
            Check("web providers unique", unique, null);
            Check("web providers ids", string.Join(",", ids.ToArray()) == "deepseek,qwen,doubao,chatgpt,gemini,grok",
                string.Join(",", ids.ToArray()));
            Check("web providers known", WebProviders.IsKnown("qwen") && WebProviders.IsKnown("custom")
                && !WebProviders.IsKnown("nope") && !WebProviders.IsKnown(""), null);

            WebProvider deepseek = WebProviders.Get("deepseek");
            Check("web provider deepseek url", deepseek != null && deepseek.Url == "https://chat.deepseek.com/",
                deepseek == null ? "null" : deepseek.Url);
            Check("web provider deepseek selectors", deepseek != null
                && Array.IndexOf(deepseek.SendClassHints, "ds-button--primary") >= 0
                && Array.IndexOf(deepseek.SendClassHints, "ds-button--circle") >= 0
                && Array.IndexOf(deepseek.ComposerSelectors, "textarea[name=\"search\"]") >= 0, null);
            Check("web provider deepseek prefill", deepseek != null && deepseek.PrefillParam == "q"
                && deepseek.BuildAskUrl("你好").StartsWith("https://chat.deepseek.com/?q=", StringComparison.Ordinal)
                && deepseek.BuildAskUrl("你好").IndexOf("%E4%BD%A0%E5%A5%BD", StringComparison.Ordinal) >= 0, null);
            Check("web provider login markers are url fragments", deepseek != null
                && deepseek.IsLoginUrl("https://chat.deepseek.com/sign_in")
                && !deepseek.IsLoginUrl("https://chat.deepseek.com/a/chat/s/1"), null);

            // 站点专属选择器按「最佳猜测」实现，这里锁住「不能被误删」。
            WebProvider chatgpt = WebProviders.Get("chatgpt");
            WebProvider gemini = WebProviders.Get("gemini");
            WebProvider grok = WebProviders.Get("grok");
            Check("web provider chatgpt selectors", chatgpt != null
                && Array.IndexOf(chatgpt.ComposerSelectors, "#prompt-textarea") >= 0
                && Array.IndexOf(chatgpt.SendSelectors, "button[data-testid=\"send-button\"]") >= 0, null);
            Check("web provider gemini selectors", gemini != null
                && Array.IndexOf(gemini.ComposerSelectors, "rich-textarea .ql-editor") >= 0
                && Array.IndexOf(gemini.SendSelectors, "button[aria-label*=\"Send\"]") >= 0, null);
            Check("web provider grok selectors", grok != null
                && Array.IndexOf(grok.ComposerSelectors, "textarea[aria-label]") >= 0
                && Array.IndexOf(grok.SendSelectors, "button[aria-label=\"Submit\"]") >= 0, null);
            Check("web provider qwen origins", WebProviders.Get("qwen") != null
                && WebProviders.Get("qwen").MatchesUrl("https://chat.qwen.ai/")
                && WebProviders.Get("qwen").MatchesUrl("https://www.qianwen.com/"), null);
            Check("web provider origins mismatch", WebProviders.Get("qwen") != null
                && !WebProviders.Get("qwen").MatchesUrl("https://chat.deepseek.com/"), null);

            // 解析：默认 / 预设 / 未知回退 / 自定义地址 / 大小写。
            Check("web provider empty -> default", WebProviders.Resolve("", "").Id == "deepseek", null);
            Check("web provider case -> preset", WebProviders.Resolve("DeepSeek", "").Id == "deepseek", null);
            Check("web provider unknown -> custom", WebProviders.Resolve("nope", "https://example.com/chat").Id == "custom",
                WebProviders.Resolve("nope", "https://example.com/chat").Id);
            WebProvider custom = WebProviders.Resolve("custom", "https://example.com/chat");
            Check("web provider custom url", custom.Url == "https://example.com/chat" && custom.IsCustom, custom.Url);
            Check("web provider custom matches", custom.MatchesUrl("https://example.com/chat/1")
                && !custom.MatchesUrl("https://other.example.org/"), null);
            Check("web provider custom enter off", !custom.EnterSends && !custom.Upload, null);
            Check("web provider custom invalid url", WebProviders.Resolve("custom", "not-a-url").Url == WebProviders.DefaultUrl,
                WebProviders.Resolve("custom", "not-a-url").Url);
            Check("web provider custom no prefill", custom.BuildAskUrl("x") == custom.Url, custom.BuildAskUrl("x"));

            // 旧配置迁移：没有 WebProvider 字段时按 ChatUrl 推断。
            Check("web provider infer default", WebProviders.InferLegacyProvider("https://chat.deepseek.com/") == "deepseek", null);
            Check("web provider infer same site", WebProviders.InferLegacyProvider("https://chat.deepseek.com") == "deepseek", null);
            Check("web provider infer custom", WebProviders.InferLegacyProvider("https://example.com/chat") == "custom", null);
            Check("web provider infer empty", WebProviders.InferLegacyProvider("") == "deepseek", null);
            Check("web provider infer qwen", WebProviders.InferLegacyProvider("https://chat.qwen.ai/") == "qwen", null);

            // 管道请求不带 provider 时按本机配置解析（旧版插件不传字段，行为与升级前一致）。
            AppConfig qwenConfig = new AppConfig();
            qwenConfig.WebProvider = "qwen";
            Check("web provider from config qwen", WebProviders.FromConfig(qwenConfig).Id == "qwen",
                WebProviders.FromConfig(qwenConfig).Id);
            AppConfig customConfig = new AppConfig();
            customConfig.WebProvider = "custom";
            customConfig.ChatUrl = "https://example.com/chat";
            Check("web provider from config custom", WebProviders.FromConfig(customConfig).Id == "custom"
                && WebProviders.FromConfig(customConfig).Url == "https://example.com/chat",
                WebProviders.FromConfig(customConfig).Url);

            // 脚本生成：注入的内容 = 共享 driver 源码 + provider 配置 JSON。
            // 配置里的字符串是 JSON 编码的（引号会变成 \"），所以用 Json.Stringify 出期望值再比对，
            // 这样断言既精确又不依赖转义细节。
            string fillDeepseek = PageScripts.BuildFillScript(WebProviders.Get("deepseek"), "测试");
            string fillChatgpt = PageScripts.BuildFillScript(WebProviders.Get("chatgpt"), "测试");
            string sendDeepseek = PageScripts.BuildSendScript(WebProviders.Get("deepseek"));
            string sendGemini = PageScripts.BuildSendScript(WebProviders.Get("gemini"));
            string stateGrok = PageScripts.BuildComposerStateScript(WebProviders.Get("grok"));

            Check("web driver embedded", fillDeepseek.IndexOf("__bubbleAskDriver", StringComparison.Ordinal) >= 0
                && fillDeepseek.IndexOf("execCommand('insertText'", StringComparison.Ordinal) >= 0
                && PageScripts.BuildOpenUploadScript().IndexOf("__bubbleAskDriver", StringComparison.Ordinal) >= 0,
                "注入脚本里应带共享 driver 源码");
            Check("web script deepseek composer",
                fillDeepseek.IndexOf(Json.Stringify("textarea[name=\"search\"]"), StringComparison.Ordinal) >= 0, null);
            Check("web script deepseek class hints",
                sendDeepseek.IndexOf(Json.Stringify("ds-button--primary"), StringComparison.Ordinal) >= 0, null);
            Check("web script chatgpt composer",
                fillChatgpt.IndexOf(Json.Stringify("#prompt-textarea"), StringComparison.Ordinal) >= 0, null);
            Check("web script chatgpt send", PageScripts.BuildSendScript(WebProviders.Get("chatgpt"))
                .IndexOf(Json.Stringify("button[data-testid=\"send-button\"]"), StringComparison.Ordinal) >= 0, null);
            Check("web script gemini send",
                sendGemini.IndexOf(Json.Stringify("button[aria-label*=\"Send\"]"), StringComparison.Ordinal) >= 0, null);
            Check("web script grok composer",
                stateGrok.IndexOf(Json.Stringify("textarea[aria-label]"), StringComparison.Ordinal) >= 0, null);
            Check("web script fill prompt", fillDeepseek.IndexOf(Json.Stringify("测试"), StringComparison.Ordinal) >= 0, null);
            Check("web script generic fallback", PageScripts.BuildComposerStateScript(WebProviders.Resolve("custom", "https://x.test/"))
                .IndexOf(Json.Stringify("[role=\"textbox\"]"), StringComparison.Ordinal) >= 0, null);
            Check("web script probe login markers", PageScripts.BuildProbeScript(WebProviders.Get("gemini"))
                .IndexOf(Json.Stringify("accounts.google.com"), StringComparison.Ordinal) >= 0, null);
            // 配置里的通用兜底必须真的来自真源（换一家 provider 也应带上同样的 generic 列表）
            Check("web script carries generic config",
                sendDeepseek.IndexOf(Json.Stringify("[role=\"textbox\"]"), StringComparison.Ordinal) >= 0
                && sendDeepseek.IndexOf(Json.Stringify("提交"), StringComparison.Ordinal) >= 0, null);
        }

        private static void TestEndpoints()
        {
            Check("endpoint base", ApiClient.ResolveEndpoint("https://api.deepseek.com") == "https://api.deepseek.com/v1/chat/completions",
                ApiClient.ResolveEndpoint("https://api.deepseek.com"));
            Check("endpoint v1", ApiClient.ResolveEndpoint("http://127.0.0.1:11434/v1/") == "http://127.0.0.1:11434/v1/chat/completions",
                ApiClient.ResolveEndpoint("http://127.0.0.1:11434/v1/"));
            Check("endpoint full", ApiClient.ResolveEndpoint("https://x.test/v1/chat/completions") == "https://x.test/v1/chat/completions",
                ApiClient.ResolveEndpoint("https://x.test/v1/chat/completions"));
            Check("endpoint empty", ApiClient.ResolveEndpoint("") == "https://api.deepseek.com/v1/chat/completions",
                ApiClient.ResolveEndpoint(""));
        }

        private static void TestPayload(string outDir)
        {
            ApiRequest request = new ApiRequest();
            request.Model = "stub-model";
            request.SystemPrompt = "系统提示";
            request.MaxTokens = 512;
            request.Messages.Add(new ApiMessage("user", "你好"));
            Dictionary<string, object> body = Json.ParseObject(ApiClient.BuildBody(request));

            Check("payload model", Json.GetString(body, "model", "") == "stub-model", Json.GetString(body, "model", ""));
            Check("payload stream", Json.GetBool(body, "stream", false), null);
            Check("payload max tokens", Json.GetInt(body, "max_tokens", 0) == 512, null);
            object[] messages = body.ContainsKey("messages") ? body["messages"] as object[] : null;
            Check("payload messages", messages != null && messages.Length == 2, messages == null ? "null" : messages.Length.ToString());
            Dictionary<string, object> system = messages != null && messages.Length > 0
                ? messages[0] as Dictionary<string, object>
                : null;
            Check("payload system role", system != null && Json.GetString(system, "role", "") == "system", null);

            string imagePath = Path.Combine(outDir, "payload.png");
            using (Bitmap bitmap = new Bitmap(40, 30))
            {
                bitmap.Save(imagePath, ImageFormat.Png);
            }
            string dataUrl = ApiClient.EncodeImage(imagePath, 20);
            Check("image data url", dataUrl.StartsWith("data:image/png;base64,"), dataUrl.Substring(0, Math.Min(30, dataUrl.Length)));

            byte[] raw = Convert.FromBase64String(dataUrl.Substring("data:image/png;base64,".Length));
            using (MemoryStream memory = new MemoryStream(raw))
            {
                using (Image decoded = Image.FromStream(memory))
                {
                    Check("image downscaled", decoded.Width == 20 && decoded.Height == 15,
                        decoded.Width + "x" + decoded.Height);
                }
            }

            ApiRequest withImage = new ApiRequest();
            withImage.Model = "stub-model";
            ApiMessage user = new ApiMessage("user", "看图");
            user.ImagePaths.Add(imagePath);
            withImage.Messages.Add(user);
            Dictionary<string, object> imageBody = Json.ParseObject(ApiClient.BuildBody(withImage));
            object[] imageMessages = imageBody["messages"] as object[];
            Dictionary<string, object> first = imageMessages != null && imageMessages.Length > 0
                ? imageMessages[0] as Dictionary<string, object>
                : null;
            object[] parts = first != null && first.ContainsKey("content") ? first["content"] as object[] : null;
            Check("payload image parts", parts != null && parts.Length == 2, parts == null ? "null" : parts.Length.ToString());
            Dictionary<string, object> imagePart = parts != null && parts.Length > 1
                ? parts[1] as Dictionary<string, object>
                : null;
            Check("payload image type", imagePart != null && Json.GetString(imagePart, "type", "") == "image_url", null);
        }

        private static void TestDeltaParsing()
        {
            string content;
            string reasoning;

            bool ok = ApiClient.TryParseDelta("{\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}", out content, out reasoning);
            Check("delta content", ok && content == "你好", content);

            ok = ApiClient.TryParseDelta("{\"choices\":[{\"delta\":{\"reasoning_content\":\"先想想\"}}]}", out content, out reasoning);
            Check("delta reasoning", ok && reasoning == "先想想" && content == "", reasoning);

            ok = ApiClient.TryParseDelta("[DONE]", out content, out reasoning);
            Check("delta done marker", !ok, null);

            ok = ApiClient.TryParseDelta("{\"choices\":[]}", out content, out reasoning);
            Check("delta empty choices", !ok, null);

            Check("full content", ApiClient.ExtractFullContent("{\"choices\":[{\"message\":{\"content\":\"整段\"}}]}") == "整段",
                ApiClient.ExtractFullContent("{\"choices\":[{\"message\":{\"content\":\"整段\"}}]}"));

            string hint = ApiClient.DescribeHttpError(401, "unauthorized");
            Check("http 401 hint", hint.IndexOf("API Key", StringComparison.Ordinal) >= 0, hint);
            string hint404 = ApiClient.DescribeHttpError(404, "no model");
            Check("http 404 hint", hint404.IndexOf("模型", StringComparison.Ordinal) >= 0, hint404);
        }

        private static void TestStreaming()
        {
            string sse =
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\n" +
                "data: [DONE]\n\n";

            using (StubServer server = new StubServer(200, "text/event-stream", sse))
            {
                ApiRequest request = new ApiRequest();
                request.BaseUrl = "http://127.0.0.1:" + server.Port;
                request.ApiKey = "sk-stub";
                request.Model = "stub-model";
                request.Messages.Add(new ApiMessage("user", "hi"));

                StringBuilder seen = new StringBuilder();
                StringBuilder thoughts = new StringBuilder();
                string full = ApiClient.StreamAsync(request,
                    delegate(string delta) { seen.Append(delta); },
                    delegate(string delta) { thoughts.Append(delta); },
                    CancellationToken.None).GetAwaiter().GetResult();

                Check("stream full text", full == "你好，世界", full);
                Check("stream deltas", seen.ToString() == full, seen.ToString());
                Check("stream reasoning", thoughts.ToString() == "想", thoughts.ToString());
                Check("stream auth header", server.LastHeaders.IndexOf("Bearer sk-stub", StringComparison.Ordinal) >= 0,
                    server.LastHeaders);
                Check("stream body model", server.LastRequestBody.IndexOf("\"stream\":true", StringComparison.Ordinal) >= 0,
                    server.LastRequestBody);
            }
        }

        private static void TestStreamingMultiline()
        {
            // SSE 规范允许一条事件里有多行 data，拼起来才是完整负载。
            // 拆开逐行解析会得到两段非法 JSON，正文会被静默丢掉。
            string sse =
                "data: {\"choices\":[{\"delta\":\n" +
                "data: {\"content\":\"多行拼接\"}}]}\n\n" +
                "data: [DONE]\n\n";

            using (StubServer server = new StubServer(200, "text/event-stream", sse))
            {
                ApiRequest request = new ApiRequest();
                request.BaseUrl = "http://127.0.0.1:" + server.Port;
                request.ApiKey = "sk-stub";
                request.Model = "stub-model";
                request.Messages.Add(new ApiMessage("user", "hi"));

                string full = ApiClient.StreamAsync(request, null, null, CancellationToken.None)
                    .GetAwaiter().GetResult();
                Check("stream multiline data", full == "多行拼接", full);
            }
        }

        private static void TestStreamingError()
        {
            using (StubServer server = new StubServer(401, "application/json", "{\"error\":\"bad key\"}"))
            {
                ApiRequest request = new ApiRequest();
                request.BaseUrl = "http://127.0.0.1:" + server.Port;
                request.ApiKey = "sk-bad";
                request.Model = "stub-model";
                request.Messages.Add(new ApiMessage("user", "hi"));

                bool threw = false;
                int status = 0;
                try
                {
                    ApiClient.StreamAsync(request, null, null, CancellationToken.None).GetAwaiter().GetResult();
                }
                catch (ApiException error)
                {
                    threw = true;
                    status = error.Status;
                }
                catch (Exception)
                {
                }
                Check("stream 401 throws", threw, null);
                Check("stream 401 status", status == 401, status.ToString());
            }
        }

        /// <summary>流中途的服务端错误帧（上下文超长、内容过滤）必须让用户看到原因，不能只留半截正文。</summary>
        private static void TestStreamErrorFrame()
        {
            string sse =
                "data: {\"choices\":[{\"delta\":{\"content\":\"前半段\"}}]}\n\n" +
                "data: {\"error\":{\"message\":\"context length exceeded\",\"code\":400}}\n\n" +
                "data: [DONE]\n\n";

            using (StubServer server = new StubServer(200, "text/event-stream", sse))
            {
                ApiRequest request = new ApiRequest();
                request.BaseUrl = "http://127.0.0.1:" + server.Port;
                request.ApiKey = "sk-stub";
                request.Model = "stub-model";
                request.Messages.Add(new ApiMessage("user", "hi"));

                bool threw = false;
                string message = "";
                try
                {
                    ApiClient.StreamAsync(request, null, null, CancellationToken.None).GetAwaiter().GetResult();
                }
                catch (ApiException error)
                {
                    threw = true;
                    message = error.Message;
                }
                Check("stream error frame throws", threw, message);
                Check("stream error frame message", message.IndexOf("服务端返回错误", StringComparison.Ordinal) >= 0,
                    message);
                Check("stream error frame detail", message.IndexOf("context length exceeded", StringComparison.Ordinal) >= 0,
                    message);
            }
        }

        /// <summary>撞到 max_tokens 上限时内容照常返回，但必须给一条非致命提示。</summary>
        private static void TestTruncationNotice()
        {
            string sse =
                "data: {\"choices\":[{\"delta\":{\"content\":\"被截断的回答\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n" +
                "data: [DONE]\n\n";

            using (StubServer server = new StubServer(200, "text/event-stream", sse))
            {
                ApiRequest request = new ApiRequest();
                request.BaseUrl = "http://127.0.0.1:" + server.Port;
                request.ApiKey = "sk-stub";
                request.Model = "stub-model";
                request.Messages.Add(new ApiMessage("user", "hi"));

                List<string> notices = new List<string>();
                string full = ApiClient.StreamAsync(request,
                    null, null,
                    delegate(string notice) { notices.Add(notice); },
                    CancellationToken.None).GetAwaiter().GetResult();

                Check("truncation keeps content", full == "被截断的回答", full);
                Check("truncation notice fired", notices.Count == 1, "count=" + notices.Count);
                Check("truncation notice text",
                    notices.Count == 1 && notices[0] == "（回答被 max_tokens 截断）",
                    notices.Count == 1 ? notices[0] : "");
            }
        }

        /// <summary>HTTP 200 但一个正文都没有：不能当成功，要明确报错。</summary>
        private static void TestEmptyAnswer()
        {
            using (StubServer server = new StubServer(200, "text/event-stream", "data: [DONE]\n\n"))
            {
                ApiRequest request = new ApiRequest();
                request.BaseUrl = "http://127.0.0.1:" + server.Port;
                request.ApiKey = "sk-stub";
                request.Model = "stub-model";
                request.Messages.Add(new ApiMessage("user", "hi"));

                bool threw = false;
                string message = "";
                try
                {
                    ApiClient.StreamAsync(request, null, null, CancellationToken.None).GetAwaiter().GetResult();
                }
                catch (ApiException error)
                {
                    threw = true;
                    message = error.Message;
                }
                Check("empty answer throws", threw, message);
                Check("empty answer message", message.IndexOf("空内容", StringComparison.Ordinal) >= 0, message);
            }
        }

        /// <summary>
        /// 超时不能和"用户主动取消"混为一谈：必须显示超时提示，并且气泡要退出流式态。
        /// 用 dt 把超时压到 1 秒，桩服务收下请求、发完响应头之后就不说话了。
        /// </summary>
        private static void TestTimeoutRecovery()
        {
            try
            {
                ApiClient.ConfigureTimeout(TimeSpan.FromSeconds(1));
                Check("timeout text seconds", ApiClient.TimeoutText.IndexOf("秒", StringComparison.Ordinal) >= 0,
                    ApiClient.TimeoutText);

                using (StubServer server = new StubServer(200, "text/event-stream", "data: [DONE]\n\n", 6000))
                {
                    AppConfig config = new AppConfig();
                    config.Mode = "api";
                    config.ApiBaseUrl = "http://127.0.0.1:" + server.Port;
                    config.ApiKey = "sk-stub";
                    config.ApiModel = "stub-model";

                    using (ApiChat chat = new ApiChat(config))
                    {
                        // 注意：气泡会回显提问内容，所以提问里不能出现断言要匹配的文案。
                        chat.Ask("网络很慢的情况", null);
                        bool shown = WaitUntil(delegate
                        {
                            return chat.Bubble != null
                                   && chat.Bubble.BodyText.IndexOf("⚠", StringComparison.Ordinal) >= 0
                                   && chat.Bubble.BodyText.IndexOf("读取响应超时", StringComparison.Ordinal) >= 0;
                        }, 20000);
                        Check("stalled body reports failure", shown,
                            chat.Bubble == null
                                ? "no bubble"
                                : "len=" + chat.Bubble.BodyText.Length
                                  + " streaming=" + chat.Bubble.IsStreaming
                                  + " body=[" + chat.Bubble.BodyText + "]");
                        // 关键：超时之后必须不再是流式态，否则输入框和发送键会一直灰着。
                        bool recovered = WaitUntil(delegate
                        {
                            return chat.Bubble != null && !chat.Bubble.IsStreaming;
                        }, 5000);
                        Check("stalled body leaves streaming state", recovered,
                            chat.Bubble == null ? "no bubble" : "streaming=" + chat.Bubble.IsStreaming);
                    }
                }
            }
            finally
            {
                ApiClient.ConfigureTimeout(ApiClient.DefaultTimeout);
            }
            Check("timeout restored", ApiClient.RequestTimeout == ApiClient.DefaultTimeout, ApiClient.TimeoutText);
        }

        /// <summary>端到端：ApiChat → 气泡 → 本地桩服务 → SSE 解析 → 回到界面线程。</summary>
        private static void TestApiChat()
        {
            string sse =
                "data: {\"choices\":[{\"delta\":{\"content\":\"闭包是\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"函数加环境。\"}}]}\n\n" +
                "data: [DONE]\n\n";

            using (StubServer server = new StubServer(200, "text/event-stream", sse))
            {
                AppConfig config = new AppConfig();
                config.Mode = "api";
                config.ApiBaseUrl = "http://127.0.0.1:" + server.Port;
                config.ApiKey = "sk-stub";
                config.ApiModel = "stub-model";

                using (ApiChat chat = new ApiChat(config))
                {
                    chat.Ask("什么是闭包", null);
                    bool got = WaitUntil(delegate
                    {
                        return chat.Bubble != null && chat.Bubble.BodyText.IndexOf("闭包是函数加环境。", StringComparison.Ordinal) >= 0;
                    }, 8000);
                    Check("api chat streams into bubble", got,
                        chat.Bubble == null ? "no bubble" : chat.Bubble.BodyText);
                    Check("api chat finished", chat.Bubble != null && !chat.Bubble.IsStreaming, null);

                    chat.Bubble.AskFollowUp("再举一个例子");
                    bool second = WaitUntil(delegate
                    {
                        return chat.Bubble.BodyText.IndexOf("再举一个例子", StringComparison.Ordinal) >= 0
                               && CountOccurrences(chat.Bubble.BodyText, "闭包是函数加环境。") >= 2;
                    }, 8000);
                    Check("api chat follow up", second,
                        chat.Bubble == null ? "no bubble" : chat.Bubble.BodyText);
                }
            }

            AppConfig noKey = new AppConfig();
            noKey.Mode = "api";
            noKey.ApiKey = "";
            using (ApiChat chat = new ApiChat(noKey))
            {
                chat.Ask("没有 key 的时候", null);
                Check("api chat requires key", chat.Bubble != null
                                              && chat.Bubble.BodyText.IndexOf("API Key", StringComparison.Ordinal) >= 0,
                    chat.Bubble == null ? "no bubble" : chat.Bubble.BodyText);
            }
        }

        private static bool WaitUntil(Func<bool> condition, int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                Application.DoEvents();
                if (condition())
                {
                    return true;
                }
                Thread.Sleep(30);
                waited += 30;
            }
            return condition();
        }

        private static int CountOccurrences(string text, string needle)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(needle))
            {
                return 0;
            }
            int count = 0;
            int index = 0;
            while ((index = text.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
            {
                count++;
                index += needle.Length;
            }
            return count;
        }

        /// <summary>
        /// HTML 版气泡的端到端验证：真的起 WebView2、喂一轮带 Markdown 的回答，
        /// 再用引擎自己的截图接口把画面存下来。DrawToBitmap 抓不到 WebView2。
        /// </summary>
        private static int RunBubbleWeb(string outDir)
        {
            Directory.CreateDirectory(outDir);
            AnswerBubble.PersistPosition = false;
            try
            {
                using (AnswerBubble bubble = new AnswerBubble(new AppConfig()))
                {
                    bubble.ShowForAsk();
                    bubble.Location = new Point(120, 120);
                    bubble.Width = 460;
                    bubble.Height = 520;
                    Pump(60);
                    bubble.SetTitle("DeepSeek · deepseek-chat");
                    bubble.BeginTurn("什么是闭包？");
                    bubble.AppendReasoning("先想清楚捕获的是变量还是值。" + Environment.NewLine);
                    bubble.AppendAnswer("闭包是**函数**加上它捕获的词法环境。" + Environment.NewLine + Environment.NewLine);
                    bubble.AppendAnswer("```js" + Environment.NewLine + "const next = makeCounter()" + Environment.NewLine + "```" + Environment.NewLine);
                    bubble.EndTurn();
                    Pump(40);
                    bubble.Activate();
                    bubble.TopMost = true;
                    Pump(10);
                    Console.WriteLine("ready=" + bubble.WebUiReady + " error=" + (bubble.WebUiError ?? "-"));
                    string path = Path.Combine(outDir, "bubble-web.png");
                    Rectangle bounds = bubble.Bounds;
                    using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height))
                    using (Graphics graphics = Graphics.FromImage(bitmap))
                    {
                        graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bitmap.Size);
                        bitmap.Save(path, ImageFormat.Png);
                    }
                    bool ok = File.Exists(path) && new FileInfo(path).Length > 2000;
                    Console.WriteLine((ok ? "SAVED " : "NO-WEBUI ") + path + " bytes=" + new FileInfo(path).Length);
                    return ok ? 0 : 3;
                }
            }
            catch (Exception error)
            {
                Console.WriteLine("FAILED " + error.Message);
                return 4;
            }
        }

        /// <summary>转消息循环若干拍（WebView2 的初始化和渲染都靠它推进）。</summary>
        private static void Pump(int ticks)
        {
            for (int i = 0; i < ticks; i += 1)
            {
                Application.DoEvents();
                Thread.Sleep(50);
            }
        }
        private static void TestOffscreenForm(string outDir)
        {
            try
            {
                using (SettingsForm form = new SettingsForm(new AppConfig()))
                {
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new Point(-3000, -3000);
                    form.Show();
                    Application.DoEvents();

                    Check("settings has pages", form.PageCount == 4, form.PageCount.ToString());

                    int rendered = 0;
                    for (int i = 0; i < form.PageCount; i++)
                    {
                        form.ShowPage(i);
                        Application.DoEvents();
                        string pagePath = Path.Combine(outDir, "settings-" + i + ".png");
                        RenderForm(form, pagePath);
                        if (new FileInfo(pagePath).Length > 2000)
                        {
                            rendered++;
                        }
                    }
                    Check("settings pages render", rendered == form.PageCount, rendered + "/" + form.PageCount);

                    string first = Path.Combine(outDir, "settings-0.png");
                    form.ShowPage(0);
                    Application.DoEvents();
                    RenderForm(form, Path.Combine(outDir, "settings.png"));
                    Check("settings form renders", new FileInfo(first).Length > 2000, first);
                    form.Close();
                }

                // 抓词提问的输入框：能建起来、画得出图，尺寸和控件齐全。
                using (QuestionForm form = new QuestionForm("分布式系统里没有银弹，这句话是什么意思？", "什么是%s"))
                {
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new Point(-3000, -3000);
                    form.Show();
                    Application.DoEvents();
                    Check("question form size", form.ClientSize.Width == 452 && form.ClientSize.Height == 208, form.ClientSize.ToString());
                    Check("question form has input", HasTextBoxControl(form), "没有 TextBox");
                    string path = Path.Combine(outDir, "question-form.png");
                    RenderForm(form, path);
                    Check("question form renders", new FileInfo(path).Length > 2000, path);
                    form.Close();
                }

                // 150% 缩放：卡片按比例放大，提示文字仍放得下。
                // 自测进程本身在 96 DPI，所以把控件字体同比例放大，模拟真实高 DPI 下的字形尺寸。
                using (QuestionForm scaled = new QuestionForm("分布式系统里没有银弹，这句话是什么意思？", "什么是%s", 1.5F))
                {
                    scaled.StartPosition = FormStartPosition.Manual;
                    scaled.Location = new Point(-3000, -3000);
                    scaled.Show();

                    List<Font> scaledFonts = new List<Font>();
                    for (int i = 0; i < scaled.Controls.Count; i++)
                    {
                        Control child = scaled.Controls[i];
                        Font bigger = new Font(child.Font.FontFamily, child.Font.Size * 1.5F, child.Font.Style);
                        scaledFonts.Add(bigger);
                        child.Font = bigger;
                    }
                    Application.DoEvents();

                    Check("question form scales with dpi",
                        scaled.ClientSize.Width == 678 && scaled.ClientSize.Height == 312,
                        scaled.ClientSize.ToString());

                    Label hint = FindLabel(scaled, "回车发送");
                    Check("question form hint label", hint != null, "没有提示标签");
                    if (hint != null)
                    {
                        Size text = TextRenderer.MeasureText(hint.Text, hint.Font);
                        Check("question form hint fits at 150%", text.Width <= hint.Width,
                            string.Format("文字 {0}px，标签 {1}px", text.Width, hint.Width));
                    }

                    string scaledPath = Path.Combine(outDir, "question-form-150.png");
                    RenderForm(scaled, scaledPath);
                    Check("question form renders at 150%", new FileInfo(scaledPath).Length > 2000, scaledPath);

                    scaled.Close();
                    for (int i = 0; i < scaledFonts.Count; i++)
                    {
                        scaledFonts[i].Dispose();
                    }
                }
            }
            catch (Exception error)
            {
                Check("settings form renders", false, error.Message);
            }
        }

        /// <summary>按文字前缀找标签（不引 LINQ，只走控件树）。</summary>
        private static Label FindLabel(Control root, string prefix)
        {
            for (int i = 0; i < root.Controls.Count; i++)
            {
                Control child = root.Controls[i];
                Label label = child as Label;
                if (label != null && label.Text != null && label.Text.StartsWith(prefix, StringComparison.Ordinal))
                {
                    return label;
                }
                Label nested = FindLabel(child, prefix);
                if (nested != null)
                {
                    return nested;
                }
            }
            return null;
        }

        /// <summary>窗口里有没有文本框（不引 LINQ，只走控件树）。</summary>
        private static bool HasTextBoxControl(Control root)
        {
            for (int i = 0; i < root.Controls.Count; i++)
            {
                Control child = root.Controls[i];
                if (child is TextBox)
                {
                    return true;
                }
                if (HasTextBoxControl(child))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 离屏出图。无边框窗口里的 RichTextBox 不响应 DrawToBitmap，
        /// 正文改用 EM_FORMATRANGE 单独画上去，否则自测截图里永远是空白。
        /// </summary>
        private static void RenderForm(Form form, string path)
        {
            using (Bitmap bitmap = new Bitmap(form.Width, form.Height))
            {
                form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height));
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    PaintRichText(form, form, graphics);
                }
                bitmap.Save(path, ImageFormat.Png);
            }
        }

        private static void PaintRichText(Control root, Form form, Graphics target)
        {
            for (int i = 0; i < root.Controls.Count; i++)
            {
                Control child = root.Controls[i];
                RichTextBox rich = child as RichTextBox;
                if (rich != null && rich.Visible && rich.Width > 0 && rich.Height > 0)
                {
                    Point formOrigin = form.PointToScreen(Point.Empty);
                    Point richOrigin = rich.PointToScreen(Point.Empty);
                    Point local = new Point(richOrigin.X - formOrigin.X, richOrigin.Y - formOrigin.Y);

                    using (Bitmap layer = new Bitmap(rich.Width, rich.Height))
                    {
                        using (Graphics layerGraphics = Graphics.FromImage(layer))
                        {
                            layerGraphics.Clear(Color.White);
                            int twipsPerPixel = 1440 / Math.Max(96, (int)layerGraphics.DpiX);
                            IntPtr hdc = layerGraphics.GetHdc();
                            FormatRange range = new FormatRange();
                            range.Hdc = hdc;
                            range.HdcTarget = hdc;
                            range.Rect = new NativeRect
                            {
                                Left = 0,
                                Top = 0,
                                Right = rich.Width * twipsPerPixel,
                                Bottom = rich.Height * twipsPerPixel
                            };
                            range.PageRect = range.Rect;
                            range.Range = new CharRange { Min = 0, Max = -1 };
                            SendMessage(rich.Handle, EmFormatRange, new IntPtr(1), ref range);
                            SendMessage(rich.Handle, EmFormatRange, IntPtr.Zero, IntPtr.Zero);
                            layerGraphics.ReleaseHdc(hdc);
                        }
                        target.DrawImageUnscaled(layer, local);
                    }
                }
                if (child.Controls.Count > 0)
                {
                    PaintRichText(child, form, target);
                }
            }
        }

        /// <summary>窗口夹回工作区：间隙由调用方给，提问卡片按 DPI 换算过之后要用这个。</summary>
        private static void TestPlacement()
        {
            Rectangle area = new Rectangle(0, 0, 1000, 800);
            Size size = new Size(200, 100);

            Point inside = WindowPlacement.Fit(area, size, new Point(300, 200), 12);
            Check("placement keeps inside", inside.X == 300 && inside.Y == 200, inside.ToString());

            Point beyond = WindowPlacement.Fit(area, size, new Point(5000, 5000), 12);
            Check("placement clamps right-bottom",
                beyond.X == 1000 - 200 - 12 && beyond.Y == 800 - 100 - 12,
                beyond.ToString());

            Point negative = WindowPlacement.Fit(area, size, new Point(-500, -500), 12);
            Check("placement clamps left-top", negative.X == 12 && negative.Y == 12, negative.ToString());

            // 窗口比工作区还大：保住左上间隙，不出现负偏移
            Point oversized = WindowPlacement.Fit(area, new Size(1200, 900), new Point(0, 0), 12);
            Check("placement oversized window", oversized.X == 12 && oversized.Y == 12, oversized.ToString());

            Point zero = WindowPlacement.Fit(area, size, new Point(5000, 5000), 0);
            Check("placement zero margin", zero.X == 800 && zero.Y == 700, zero.ToString());
        }

        private static void TestBubble(string outDir)
        {
            try
            {
                AppConfig config = new AppConfig();

                // 第一段：内容变长时气泡跟着长高，但不超过上限。
                using (AnswerBubble longBubble = new AnswerBubble(config))
                {
                    longBubble.StartPosition = FormStartPosition.Manual;
                    longBubble.Location = new Point(-3000, -3000);
                    longBubble.ShowForAsk();
                    Application.DoEvents();
                    longBubble.BeginTurn("长内容");
                    int before = longBubble.Height;
                    for (int i = 0; i < 30; i++)
                    {
                        longBubble.AppendAnswer("第 " + (i + 1) + " 行补充说明：闭包让变量活得比函数调用更久。\n");
                    }
                    longBubble.EndTurn();
                    Application.DoEvents();
                    // 尺寸和网页版小窗统一：固定为 窗口宽 × 窗口高，不随内容伸缩
                    Check("bubble fixed width", longBubble.Width == config.WindowWidth, longBubble.Width + " vs " + config.WindowWidth);
                    Check("bubble fixed height", longBubble.Height == config.WindowHeight, longBubble.Height + " vs " + config.WindowHeight);
                    longBubble.Close();
                }

                // 位置：和网页版小窗共用 WindowX/WindowY，存过就照原样出来（夹进工作区）。
                AppConfig placed = new AppConfig();
                placed.WindowX = 200;
                placed.WindowY = 150;
                using (AnswerBubble positioned = new AnswerBubble(placed))
                {
                    positioned.ShowForAsk();
                    Application.DoEvents();
                    Point expect = WindowPlacement.Fit(
                        Screen.FromPoint(new Point(200, 150)).WorkingArea,
                        positioned.Size,
                        new Point(200, 150));
                    Check("bubble uses saved position", positioned.Location == expect,
                        positioned.Location + " vs " + expect);
                    positioned.Close();
                }

                // 第二段：短内容 + 报错，出一张能看全的图。
                using (AnswerBubble bubble = new AnswerBubble(config))
                {
                    bubble.StartPosition = FormStartPosition.Manual;
                    bubble.Location = new Point(120, 120);
                    bubble.SetTitle("DeepSeek · deepseek-chat");
                    bubble.ShowForAsk();
                    Application.DoEvents();

                    bubble.BeginTurn("什么是闭包");
                    bubble.AppendReasoning("先想一下");
                    Check("bubble streaming", bubble.IsStreaming, null);
                    bubble.AppendAnswer("闭包是函数");
                    bubble.AppendAnswer("加上它捕获的环境。");
                    bubble.EndTurn();
                    Application.DoEvents();

                    Check("bubble not streaming", !bubble.IsStreaming, null);
                    Check("bubble text", bubble.BodyText.IndexOf("闭包是函数", StringComparison.Ordinal) >= 0,
                        bubble.BodyText.Length.ToString());

                    bubble.FailTurn("测试错误提示");
                    Check("bubble error shown", bubble.BodyText.IndexOf("测试错误提示", StringComparison.Ordinal) >= 0, null);

                    string path = Path.Combine(outDir, "bubble.png");
                    RenderForm(bubble, path);
                    Check("bubble renders", new FileInfo(path).Length > 2000, path);
                    bubble.Close();
                }
            }
            catch (Exception error)
            {
                Console.WriteLine(error.ToString());
                Check("bubble renders", false, error.Message);
            }
        }

        private static void TestIcon()
        {
            try
            {
                using (Icon icon = IconFactory.Create(32))
                {
                    Check("icon created", icon.Width == 32, "w=" + icon.Width);
                }
            }
            catch (Exception error)
            {
                Check("icon created", false, error.Message);
            }
        }
    }

    /// <summary>自测用的最小 HTTP 服务：收一次请求，回一段固定的响应。</summary>
    internal class StubServer : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly Thread _thread;
        private readonly int _status;
        private readonly string _contentType;
        private readonly string _body;
        private volatile bool _stopping;
        private volatile string _lastRequestBody = "";
        private volatile string _lastHeaders = "";
        private readonly int _stallMs;

        public StubServer(int status, string contentType, string body)
            : this(status, contentType, body, 0)
        {
        }

        /// <summary>stallMs &gt; 0 时：先回响应头，再干等这么久才写正文，用来制造"超时"。</summary>
        public StubServer(int status, string contentType, string body, int stallMs)
        {
            _status = status;
            _contentType = contentType;
            _body = body;
            _stallMs = stallMs;
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _thread = new Thread(Run);
            _thread.IsBackground = true;
            _thread.Start();
        }

        public int Port { get; private set; }

        public string LastRequestBody
        {
            get { return _lastRequestBody; }
        }

        public string LastHeaders
        {
            get { return _lastHeaders; }
        }

        public void Dispose()
        {
            _stopping = true;
            try
            {
                _listener.Stop();
            }
            catch
            {
            }
        }

        private void Run()
        {
            while (!_stopping)
            {
                TcpClient client = null;
                try
                {
                    client = _listener.AcceptTcpClient();
                }
                catch
                {
                    return;
                }
                try
                {
                    Handle(client);
                }
                catch
                {
                }
                finally
                {
                    try
                    {
                        client.Close();
                    }
                    catch
                    {
                    }
                }
            }
        }

        private void Handle(TcpClient client)
        {
            using (NetworkStream stream = client.GetStream())
            {
                MemoryStream received = new MemoryStream();
                byte[] buffer = new byte[8192];
                int headerEnd = -1;
                while (headerEnd < 0)
                {
                    int read = stream.Read(buffer, 0, buffer.Length);
                    if (read <= 0)
                    {
                        return;
                    }
                    received.Write(buffer, 0, read);
                    headerEnd = FindHeaderEnd(received.ToArray());
                }

                byte[] all = received.ToArray();
                string head = Encoding.ASCII.GetString(all, 0, headerEnd);
                _lastHeaders = head;

                if (head.IndexOf("100-continue", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    byte[] cont = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");
                    stream.Write(cont, 0, cont.Length);
                    stream.Flush();
                }

                int length = ParseContentLength(head);
                int bodyStart = headerEnd + 4;
                while (all.Length - bodyStart < length)
                {
                    int read = stream.Read(buffer, 0, buffer.Length);
                    if (read <= 0)
                    {
                        break;
                    }
                    received.Write(buffer, 0, read);
                    all = received.ToArray();
                }
                int available = all.Length - bodyStart;
                _lastRequestBody = length > 0 && available > 0
                    ? Encoding.UTF8.GetString(all, bodyStart, Math.Min(length, available))
                    : "";

                byte[] payload = Encoding.UTF8.GetBytes(_body);
                string statusText = _status == 200 ? "OK" : "Error";
                string responseHead = "HTTP/1.1 " + _status + " " + statusText + "\r\n" +
                                      "Content-Type: " + _contentType + "\r\n" +
                                      "Content-Length: " + payload.Length + "\r\n" +
                                      "Connection: close\r\n\r\n";
                byte[] headBytes = Encoding.ASCII.GetBytes(responseHead);
                stream.Write(headBytes, 0, headBytes.Length);
                stream.Flush();
                if (_stallMs > 0)
                {
                    // 响应头已经发出去了，正文故意拖住——客户端此时只能靠超时脱身。
                    Thread.Sleep(_stallMs);
                }
                stream.Write(payload, 0, payload.Length);
                stream.Flush();
            }
        }

        private static int FindHeaderEnd(byte[] data)
        {
            for (int i = 0; i + 3 < data.Length; i++)
            {
                if (data[i] == 13 && data[i + 1] == 10 && data[i + 2] == 13 && data[i + 3] == 10)
                {
                    return i;
                }
            }
            return -1;
        }

        private static int ParseContentLength(string head)
        {
            string[] lines = head.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                {
                    int value;
                    if (int.TryParse(line.Substring("Content-Length:".Length).Trim(), out value))
                    {
                        return value;
                    }
                }
            }
            return 0;
        }
    }
}
