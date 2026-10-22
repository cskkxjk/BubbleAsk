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
    /// <summary>管理一个独立的 Edge 应用窗口：启动、定位、置顶、找句柄。</summary>
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

        public EdgeHost(AppConfig config)
        {
            _config = config;
        }

        public static string FindEdgePath(string configured)
        {
            if (!string.IsNullOrEmpty(configured) && File.Exists(configured))
            {
                return configured;
            }
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe")
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(candidates[i]))
                {
                    return candidates[i];
                }
            }
            return null;
        }

        public bool IsRunning
        {
            get { return FindWindowHandle() != IntPtr.Zero; }
        }

        public IntPtr Handle
        {
            get { return FindWindowHandle(); }
        }

        /// <summary>没有窗口就启动一个；已有则直接返回。</summary>
        public void EnsureStarted()
        {
            if (FindWindowHandle() != IntPtr.Zero)
            {
                return;
            }
            string edge = FindEdgePath(_config.EdgePath);
            if (string.IsNullOrEmpty(edge))
            {
                throw new InvalidOperationException("找不到 Microsoft Edge，请在设置里指定 msedge.exe 路径。");
            }
            string profile = _config.EffectiveProfileDir;
            Directory.CreateDirectory(profile);

            Point position = ComputePosition();
            // --disable-sync / --disable-extensions：应用窗口是"只用来跑 DeepSeek 的独立 profile"，
            // 不能被账号同步拉进来的第三方扩展（比如各种搜索小助手）注入，否则会干扰页面注入。
            string arguments = string.Format(
                "--app=\"{0}\" --user-data-dir=\"{1}\" --remote-debugging-port={2} --remote-allow-origins=* " +
                "--no-first-run --no-default-browser-check --disable-features=msEdgeFirstRunExperience " +
                "--disable-sync --disable-extensions --disable-component-extensions-with-background-pages " +
                "--window-size={3},{4} --window-position={5},{6}",
                _config.ChatUrl,
                profile,
                _config.CdpPort,
                _config.WindowWidth,
                _config.WindowHeight,
                position.X,
                position.Y);

            ProcessStartInfo info = new ProcessStartInfo(edge, arguments);
            info.UseShellExecute = false;
            Process.Start(info);
            Log.Info("已启动 Edge 应用窗口: " + arguments);

            // 等窗口出现，最多 15 秒。
            for (int i = 0; i < 60; i++)
            {
                System.Threading.Thread.Sleep(250);
                if (FindWindowHandle() != IntPtr.Zero)
                {
                    break;
                }
            }
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
            get { return FindWindowHandle() != IntPtr.Zero; }
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

        /// <summary>关掉这个应用窗口（Edge 进程可能继续驻留，下次提问会重新挂上来）。</summary>
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

        public void MoveNearCursor()
        {
            IntPtr handle = FindWindowHandle();
            if (handle == IntPtr.Zero)
            {
                return;
            }
            Point position = ComputePosition();
            SetWindowPos(handle, _config.TopMost ? HwndTopmost : IntPtr.Zero,
                position.X, position.Y, _config.WindowWidth, _config.WindowHeight,
                SwpNoActivate | 0x0004 /* SWP_NOZORDER when not topmost */);
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

        /// <summary>结束这个 profile 对应的 Edge 进程树。</summary>
        public void Stop()
        {
            List<int> pids = FindProfilePids();
            foreach (int pid in pids)
            {
                try
                {
                    Process.GetProcessById(pid).Kill();
                }
                catch
                {
                }
            }
            _hwnd = IntPtr.Zero;
        }

        private Point ComputePosition()
        {
            Point cursor = Cursor.Position;
            Rectangle area = Screen.FromPoint(cursor).WorkingArea;
            int width = _config.WindowWidth;
            int height = _config.WindowHeight;
            int x = cursor.X + 20;
            int y = cursor.Y + 20;
            if (x + width > area.Right)
            {
                x = cursor.X - width - 20;
            }
            if (x < area.Left)
            {
                x = area.Left + 10;
            }
            if (y + height > area.Bottom)
            {
                y = area.Bottom - height - 10;
            }
            if (y < area.Top)
            {
                y = area.Top + 10;
            }
            return new Point(x, y);
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
                if (cls.ToString() != "Chrome_WidgetWin_1")
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
            string needle = _config.EffectiveProfileDir;
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe'"))
                {
                    foreach (ManagementBaseObject item in searcher.Get())
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
                }
            }
            catch (Exception error)
            {
                Log.Warn("WMI 查询 Edge 进程失败: " + error.Message);
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
