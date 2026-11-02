using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Win32;

namespace BubbleAsk
{
    /// <summary>一个 Chromium 内核的浏览器（Edge / Chrome / Brave / Vivaldi / Opera / Chromium）。</summary>
    public class BrowserInfo
    {
        public string Id;
        public string DisplayName;
        public string ExePath;

        /// <summary>进程名，比如 msedge.exe。找窗口、杀进程都要用它。</summary>
        public string ExeName
        {
            get
            {
                if (string.IsNullOrEmpty(ExePath))
                {
                    return "";
                }
                return Path.GetFileName(ExePath);
            }
        }

        public string Version
        {
            get
            {
                try
                {
                    string path = ExePath;
                    if (string.IsNullOrEmpty(path) || !File.Exists(path))
                    {
                        return "";
                    }
                    return System.Diagnostics.FileVersionInfo.GetVersionInfo(path).FileVersion;
                }
                catch
                {
                    return "";
                }
            }
        }

        /// <summary>“Microsoft Edge 156.0.4314.58”，给设置页的下拉框用。</summary>
        public override string ToString()
        {
            string version = Version;
            return version.Length == 0 ? DisplayName : DisplayName + " " + version;
        }
    }

    /// <summary>
    /// 找本机装了哪些 Chromium 内核浏览器。
    /// 注册表 App Paths 优先（装到非默认目录也能找到），再扫常见安装路径。
    /// 这套浏览器都支持 --app / --user-data-dir / --remote-debugging-port，网页版链路对它们通用。
    /// </summary>
    public static class BrowserLocator
    {
        public const string AutoId = "auto";
        public const string AutoName = "自动检测（推荐）";

        /// <summary>认的顺序：先 Edge，再 Chrome，然后其它。同时决定"自动检测"挑哪个。</summary>
        private static readonly string[] KnownIds = new string[]
        {
            "edge", "chrome", "brave", "vivaldi", "opera", "chromium"
        };

        private static string DisplayNameOf(string id)
        {
            if (id == "edge") return "Microsoft Edge";
            if (id == "chrome") return "Google Chrome";
            if (id == "brave") return "Brave";
            if (id == "vivaldi") return "Vivaldi";
            if (id == "opera") return "Opera";
            if (id == "chromium") return "Chromium";
            return id;
        }

        private static string ExeNameOf(string id)
        {
            if (id == "edge") return "msedge.exe";
            if (id == "brave") return "brave.exe";
            if (id == "vivaldi") return "vivaldi.exe";
            if (id == "opera") return "opera.exe";
            return "chrome.exe";
        }

        /// <summary>某个浏览器的常见安装目录（按优先级）。</summary>
        private static string[] CandidatePaths(string id)
        {
            List<string> list = new List<string>();
            string[] roots = new string[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            };
            string[] subDirs;
            if (id == "edge")
            {
                subDirs = new string[] { @"Microsoft\Edge\Application\" };
            }
            else if (id == "chrome")
            {
                subDirs = new string[] { @"Google\Chrome\Application\" };
            }
            else if (id == "brave")
            {
                subDirs = new string[] { @"BraveSoftware\Brave-Browser\Application\" };
            }
            else if (id == "vivaldi")
            {
                subDirs = new string[] { @"Vivaldi\Application\" };
            }
            else if (id == "opera")
            {
                subDirs = new string[] { @"Opera\", @"Programs\Opera\" };
            }
            else
            {
                subDirs = new string[] { @"Chromium\Application\" };
            }
            string exe = ExeNameOf(id);
            for (int i = 0; i < roots.Length; i++)
            {
                if (string.IsNullOrEmpty(roots[i]))
                {
                    continue;
                }
                for (int j = 0; j < subDirs.Length; j++)
                {
                    list.Add(Path.Combine(roots[i], subDirs[j] + exe));
                }
            }
            return list.ToArray();
        }

        /// <summary>
        /// 扫出本机所有可用的 Chromium 浏览器，按 Edge → Chrome → … 的顺序。
        /// 同一个路径只出一遍（Edge 和 Chrome 都可能注册了 App Paths）。
        /// </summary>
        public static List<BrowserInfo> DetectAll()
        {
            List<BrowserInfo> result = new List<BrowserInfo>();
            for (int i = 0; i < KnownIds.Length; i++)
            {
                string id = KnownIds[i];
                string path = DetectOne(id);
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }
                bool duplicated = false;
                for (int j = 0; j < result.Count; j++)
                {
                    if (string.Equals(result[j].ExePath, path, StringComparison.OrdinalIgnoreCase))
                    {
                        duplicated = true;
                        break;
                    }
                }
                if (duplicated)
                {
                    continue;
                }
                BrowserInfo info = new BrowserInfo();
                info.Id = id;
                info.DisplayName = DisplayNameOf(id);
                info.ExePath = path;
                result.Add(info);
            }
            return result;
        }

        /// <summary>找一个浏览器：先注册表，再常见路径。找不到返回 null。</summary>
        public static string DetectOne(string id)
        {
            string fromRegistry = FindInRegistry(ExeNameOf(id));
            if (!string.IsNullOrEmpty(fromRegistry))
            {
                return fromRegistry;
            }
            string[] candidates = CandidatePaths(id);
            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(candidates[i]))
                {
                    return candidates[i];
                }
            }
            return null;
        }

        /// <summary>HKCU / HKLM / WOW6432Node 的 App Paths，装到 D 盘之类的也能找到。</summary>
        private static string FindInRegistry(string exeName)
        {
            string[] roots = new string[]
            {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\"
            };
            for (int i = 0; i < roots.Length; i++)
            {
                string path = ReadAppPath(Registry.CurrentUser, roots[i] + exeName);
                if (!string.IsNullOrEmpty(path))
                {
                    return path;
                }
                path = ReadAppPath(Registry.LocalMachine, roots[i] + exeName);
                if (!string.IsNullOrEmpty(path))
                {
                    return path;
                }
            }
            return null;
        }

        private static string ReadAppPath(RegistryKey root, string subKey)
        {
            try
            {
                using (RegistryKey key = root.OpenSubKey(subKey))
                {
                    if (key == null)
                    {
                        return null;
                    }
                    string value = key.GetValue("") as string;
                    if (string.IsNullOrEmpty(value))
                    {
                        return null;
                    }
                    value = value.Trim().Trim('"');
                    return File.Exists(value) ? value : null;
                }
            }
            catch
            {
                return null;
            }
        }

        /// <summary>把路径反查成一个 BrowserInfo（认不出就用文件名当名字）。</summary>
        public static BrowserInfo Describe(string exePath)
        {
            BrowserInfo info = new BrowserInfo();
            info.ExePath = exePath;
            info.Id = IdFromPath(exePath);
            info.DisplayName = DisplayNameOf(info.Id);
            if (info.Id == null)
            {
                info.Id = "custom";
                info.DisplayName = Path.GetFileNameWithoutExtension(exePath);
            }
            return info;
        }

        private static string IdFromPath(string exePath)
        {
            if (string.IsNullOrEmpty(exePath))
            {
                return null;
            }
            string name = Path.GetFileName(exePath).ToLowerInvariant();
            for (int i = 0; i < KnownIds.Length; i++)
            {
                if (ExeNameOf(KnownIds[i]).ToLowerInvariant() == name)
                {
                    return KnownIds[i];
                }
            }
            return null;
        }

        /// <summary>
        /// 决定这次用哪个浏览器：
        /// 1. 配置里写了可用的路径 → 用它；
        /// 2. 否则自动检测，按 Edge → Chrome → … 取第一个；
        /// 3. 都没有 → 返回 null，由调用方给用户明确的提示。
        /// </summary>
        public static BrowserInfo Resolve(string configuredPath)
        {
            if (!string.IsNullOrEmpty(configuredPath) && File.Exists(configuredPath))
            {
                return Describe(configuredPath);
            }
            List<BrowserInfo> found = DetectAll();
            return found.Count > 0 ? found[0] : null;
        }
    }
}
