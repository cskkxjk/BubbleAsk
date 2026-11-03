using System;
using System.Windows.Forms;
using Microsoft.Win32;

namespace BubbleAsk
{
    /// <summary>开机自启：只写当前用户的 Run 键，不需要管理员权限。</summary>
    public static class AutoStart
    {
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string ValueName = "BubbleAsk";

        public static string ExecutablePath
        {
            get { return Application.ExecutablePath; }
        }

        public static bool IsEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                {
                    if (key == null)
                    {
                        return false;
                    }
                    string value = key.GetValue(ValueName) as string;
                    if (string.IsNullOrEmpty(value))
                    {
                        return false;
                    }
                    return string.Equals(value.Trim('"'), ExecutablePath, StringComparison.OrdinalIgnoreCase);
                }
            }
            catch (Exception error)
            {
                Log.Warn("读取开机自启失败: " + error.Message);
                return false;
            }
        }

        public static bool SetEnabled(bool enabled)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (key == null)
                    {
                        return false;
                    }
                    if (enabled)
                    {
                        key.SetValue(ValueName, "\"" + ExecutablePath + "\"", RegistryValueKind.String);
                    }
                    else
                    {
                        key.DeleteValue(ValueName, false);
                    }
                }
                Log.Info("开机自启已" + (enabled ? "开启" : "关闭") + ": " + ExecutablePath);
                return true;
            }
            catch (Exception error)
            {
                Log.Error("设置开机自启失败", error);
                return false;
            }
        }

        /// <summary>
        /// 启动时按配置对齐一次：程序被搬到别处时，把注册表里的旧路径改过来；
        /// 配置关了就把条目删掉，不留一个指向不存在文件的启动项。
        /// </summary>
        public static void Sync(AppConfig config)
        {
            try
            {
                bool current = IsEnabled();
                if (config.StartWithWindows && !current)
                {
                    SetEnabled(true);
                }
                else if (!config.StartWithWindows && current)
                {
                    SetEnabled(false);
                }
            }
            catch (Exception error)
            {
                Log.Warn("同步开机自启失败: " + error.Message);
            }
        }
    }
}
