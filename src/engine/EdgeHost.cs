using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>
    /// 管理一个独立的浏览器应用窗口（Edge / Chrome / Brave / Vivaldi / Opera / Chromium）：
    /// 启动、定位、置顶、找句柄。这些都走 Chromium 通用的 --app / --user-data-dir / --remote-debugging-port，
    /// 所以同一套逻辑对它们都成立，区别只在 exe 名字和 profile 目录。
    /// </summary>
    public class EdgeHost
    {
        private const int SwRestore = 9;
        private const int SwShow = 5;
        private static readonly IntPtr HwndTopmost = new IntPtr(-1);
        private const uint SwpNoActivate = 0x0010;
        private const uint SwpNoSize = 0x0001;
        private const uint SwpNoMove = 0x0002;
        private const uint WmClose = 0x0010;

        private readonly AppConfig _config;
        private IntPtr _hwnd = IntPtr.Zero;
        private BrowserInfo _browser;

        public EdgeHost(AppConfig config)
        {
            _config = config;
        }

        /// <summary>这次实际使用的浏览器（解析结果带缓存，找不到时为 null）。</summary>
        public BrowserInfo Browser
        {
            get { return ResolveBrowser(); }
        }

        /// <summary>兼容旧调用：返回自动检测/配置解析出的浏览器 exe 路径。</summary>
        public static string FindEdgePath(string configured)
        {
            BrowserInfo info = BrowserLocator.Resolve(configured);
            return info == null ? null : info.ExePath;
        }

        private BrowserInfo ResolveBrowser()
        {
            if (_browser != null && File.Exists(_browser.ExePath))
            {
                return _browser;
            }
            _browser = BrowserLocator.Resolve(_config.BrowserPath);
            return _browser;
        }

        /// <summary>这个浏览器专属的 profile 目录（换浏览器不会互相污染登录态）。</summary>
        public string EffectiveProfileDir
        {
            get
            {
                BrowserInfo info = ResolveBrowser();
                return _config.EffectiveProfileDirFor(info == null ? "edge" : info.Id);
            }
        }

        public bool IsRunning
        {
            get { return FindWindowHandle() != IntPtr.Zero; }
        }

        public IntPtr Handle
        {
            get { return FindWindowHandle(); }
        }

        /// <summary>
        /// 没有窗口就启动一个；已有则直接返回。失败会抛异常。
        /// <paramref name="url"/> 是这次要打开的服务方入口（window 单实例：同一个窗口里换页面靠 CDP 导航）。
        /// </summary>
        public void EnsureStarted(string url)
        {
            if (FindWindowHandle() != IntPtr.Zero)
            {
                return;
            }
            BrowserInfo browser = ResolveBrowser();
            if (browser == null)
            {
                throw new InvalidOperationException(
                    "没有找到可用的浏览器。请安装 Edge / Chrome（或其它 Chromium 内核浏览器），" +
                    "或者在设置里手动指定浏览器 exe 路径。");
            }

            string profile = EffectiveProfileDir;
            Directory.CreateDirectory(profile);

            string target = string.IsNullOrEmpty(url) ? _config.ChatUrl : url;
            Point position = ComputePosition();
            // --disable-sync / --disable-extensions：应用窗口是"只用来跑网页版服务方的独立 profile"，
            // 不能被账号同步拉进来的第三方扩展（比如各种搜索小助手）注入，否则会干扰页面注入。
            StringBuilder arguments = new StringBuilder();
            arguments.Append("--app=\"" + target + "\"");
            arguments.Append(" --user-data-dir=\"" + profile + "\"");
            arguments.Append(" --remote-debugging-port=" + _config.CdpPort);
            arguments.Append(" --remote-allow-origins=*");
            arguments.Append(" --no-first-run --no-default-browser-check");
            arguments.Append(" --disable-sync --disable-extensions");
            arguments.Append(" --disable-component-extensions-with-background-pages");
            arguments.Append(" --window-size=" + _config.WindowWidth + "," + _config.WindowHeight);
            arguments.Append(" --window-position=" + position.X + "," + position.Y);
            if (string.Equals(browser.Id, "edge", StringComparison.OrdinalIgnoreCase))
            {
                // Edge 专有的首次运行引导，别的浏览器不认识这个 feature 名，别传。
                arguments.Append(" --disable-features=msEdgeFirstRunExperience");
            }

            ProcessStartInfo info = new ProcessStartInfo(browser.ExePath, arguments.ToString());
            info.UseShellExecute = false;
            Process.Start(info);
            Log.Info("已启动 " + browser.DisplayName + " 应用窗口 (" + browser.ExePath + "): " + arguments);

            // 等窗口出现，最多 15 秒。等不到就明确报错，不要让它一路飘到"找不到调试端口"那种误导性提示。
            for (int i = 0; i < 60; i++)
            {
                System.Threading.Thread.Sleep(250);
                if (FindWindowHandle() != IntPtr.Zero)
                {
                    Log.Info("浏览器窗口已就绪");
                    return;
                }
            }
            throw new TimeoutException(
                browser.DisplayName + " 窗口在 15 秒内没有出现。可能是 profile 被占用、" +
                "浏览器正在更新，或者被安全软件拦住了。");
        }

        public void ShowAndFocus()
        {
            IntPtr handle = FindWindowHandle();
            if (handle == IntPtr.Zero)
            {
                return;
            }
            ShowWindow(handle, SwRestore);
            ShowWindow(handle, SwShow);
            SetForegroundWindow(handle);
            if (_config.TopMost)
            {
                SetWindowPos(handle, HwndTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
            }
        }

        public void Hide()
        {
            IntPtr handle = FindWindowHandle();
            if (handle != IntPtr.Zero)
            {
                ShowWindow(handle, 0);
            }
        }

        /// <summary>窗口在不在（可见才算）。</summary>
        public bool IsVisible
        {
            get
            {
                IntPtr handle = FindWindowHandle();
                return handle != IntPtr.Zero && IsWindowVisible(handle);
            }
        }

        /// <summary>窗口是不是当前前台窗口——用来做“再按一次收起”。</summary>
        public bool IsForeground
        {
            get
            {
                IntPtr handle = FindWindowHandle();
                return handle != IntPtr.Zero && GetForegroundWindow() == handle;
            }
        }

        /// <summary>关掉这个应用窗口（浏览器进程可能继续驻留，下次提问会重新挂上来）。</summary>
        public bool CloseWindow()
        {
            IntPtr handle = FindWindowHandle();
            if (handle == IntPtr.Zero)
            {
                return false;
            }
            PostMessage(handle, WmClose, IntPtr.Zero, IntPtr.Zero);
            _hwnd = IntPtr.Zero;
            return true;
        }

        public void ApplyTopMost()
        {
            IntPtr handle = FindWindowHandle();
            if (handle == IntPtr.Zero)
            {
                return;
            }
            SetWindowPos(handle, _config.TopMost ? HwndTopmost : new IntPtr(-2), 0, 0, 0, 0,
                SwpNoMove | SwpNoSize | SwpNoActivate);
        }

        /// <summary>结束这个 profile 对应的浏览器进程。</summary>
        public void Stop()
        {
            List<int> pids = FindProfilePids();
            foreach (int pid in pids)
            {
                try
                {
                    using (Process process = Process.GetProcessById(pid))
                    {
                        process.Kill();
                    }
                    Log.Info("已结束浏览器进程 " + pid);
                }
                catch (Exception error)
                {
                    Log.Warn("结束浏览器进程 " + pid + " 失败: " + error.Message);
                }
            }
            _hwnd = IntPtr.Zero;
        }

        private Point ComputePosition()
        {
            // 和 API 气泡共用同一个位置（WindowX/WindowY），拖过之后两边都在同一个地方；
            // 没定过位置就走 WindowPlacement 的默认位置（右侧居中），不再跟着鼠标跑。
            Size size = new Size(_config.WindowWidth, _config.WindowHeight);
            return WindowPlacement.Resolve(_config, size);
        }

        private IntPtr FindWindowHandle()
        {
            if (_hwnd != IntPtr.Zero && IsWindow(_hwnd))
            {
                return _hwnd;
            }
            _hwnd = IntPtr.Zero;

            List<int> pids = FindProfilePids();
            if (pids.Count == 0)
            {
                return IntPtr.Zero;
            }

            EnumWindows(delegate(IntPtr handle, IntPtr param)
            {
                if (!IsWindowVisible(handle))
                {
                    return true;
                }
                uint pid;
                GetWindowThreadProcessId(handle, out pid);
                if (!pids.Contains((int)pid))
                {
                    return true;
                }
                StringBuilder cls = new StringBuilder(256);
                GetClassName(handle, cls, cls.Capacity);
                // Chromium 系浏览器的应用窗口都叫 Chrome_WidgetWin_1（少数版本是 _0）。
                string className = cls.ToString();
                if (className.IndexOf("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase) != 0)
                {
                    return true;
                }
                StringBuilder title = new StringBuilder(512);
                GetWindowText(handle, title, title.Capacity);
                if (title.Length == 0)
                {
                    return true;
                }
                _hwnd = handle;
                return false;
            }, IntPtr.Zero);

            return _hwnd;
        }

        private List<int> FindProfilePids()
        {
            List<int> result = new List<int>();
            string needle = EffectiveProfileDir;
            BrowserInfo browser = ResolveBrowser();
            string exeName = browser == null ? "msedge.exe" : browser.ExeName;
            if (string.IsNullOrEmpty(exeName))
            {
                exeName = "msedge.exe";
            }
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = '" + exeName + "'"))
                {
                    using (ManagementObjectCollection items = searcher.Get())
                    {
                        foreach (ManagementBaseObject item in items)
                        {
                            try
                            {
                                object commandLine = item["CommandLine"];
                                if (commandLine == null)
                                {
                                    continue;
                                }
                                if (commandLine.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                                {
                                    result.Add(Convert.ToInt32(item["ProcessId"]));
                                }
                            }
                            finally
                            {
                                item.Dispose();
                            }
                        }
                    }
                }
            }
            catch (Exception error)
            {
                Log.Warn("WMI 查询浏览器进程失败: " + error.Message);
            }
            return result;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    }
}
