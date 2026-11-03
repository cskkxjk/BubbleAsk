using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;

namespace BubbleAsk
{
    /// <summary>
    /// 服务与所有客户端之间的契约：协议版本、管道名、发现文件。
    ///
    /// 放在 shared 里是为了让客户端不必反向依赖服务端的类型 ——
    /// 托盘应用只编译 shared + ui，服务只编译 shared + engine + service。
    /// </summary>
    public static class IpcContract
    {
        /// <summary>协议版本。任一端不一致就明确报错，不要"尽量兼容"。</summary>
        public const int ProtocolVersion = 2;

        /// <summary>服务版本。</summary>
        public const string AppVersion = "2.0.0";

        /// <summary>服务模式的命令行开关：同一个 exe，带这个参数就不进界面。</summary>
        public const string ServiceSwitch = "--service";

        /// <summary>管道名：前缀 + 当前用户名，避免不同登录会话之间串台。</summary>
        public static string PipeName
        {
            get { return "BubbleAsk.Ipc.v" + ProtocolVersion + "." + Sanitize(Environment.UserName); }
        }

        /// <summary>发现文件：记录协议版本、管道名、pid 与服务 exe 路径。</summary>
        public static string DiscoveryPath
        {
            get { return Path.Combine(AppConfig.DataDir, "ipc.json"); }
        }

        /// <summary>用户名可能含非 ASCII，压成管道名安全字符。</summary>
        public static string Sanitize(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "default";
            }
            System.Text.StringBuilder builder = new System.Text.StringBuilder(value.Length);
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                bool keep = (current >= '0' && current <= '9')
                    || (current >= 'a' && current <= 'z')
                    || (current >= 'A' && current <= 'Z');
                builder.Append(keep ? current : '_');
            }
            return builder.ToString();
        }

        /// <summary>服务把发现信息写下来，供所有客户端读取。</summary>
        public static void WriteDiscovery(string exePath)
        {
            try
            {
                Directory.CreateDirectory(AppConfig.DataDir);
                Dictionary<string, object> data = new Dictionary<string, object>();
                data["version"] = ProtocolVersion;
                data["app"] = AppVersion;
                data["pipe"] = PipeName;
                data["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
                data["exe"] = exePath ?? "";
                File.WriteAllText(DiscoveryPath, Json.Stringify(data));
            }
            catch (Exception error)
            {
                Log.Warn("写入发现文件失败: " + error.Message);
            }
        }

        /// <summary>
        /// 读发现文件。刻意不去删除它 —— 它同时是「服务装在哪」的长期记录，
        /// 客户端靠 exe 字段在服务没跑时知道该拉起哪个程序。
        /// </summary>
        public static Dictionary<string, object> ReadDiscovery()
        {
            try
            {
                if (!File.Exists(DiscoveryPath))
                {
                    return null;
                }
                Dictionary<string, object> data = Json.ParseObject(File.ReadAllText(DiscoveryPath));
                return data.Count == 0 ? null : data;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>服务退出时把 pid 置 0，但保留 exe 路径。</summary>
        public static void MarkStopped()
        {
            try
            {
                Dictionary<string, object> data = ReadDiscovery();
                if (data == null)
                {
                    return;
                }
                data["pid"] = 0;
                File.WriteAllText(DiscoveryPath, Json.Stringify(data));
            }
            catch
            {
                // 标记失败不影响功能：客户端探活会失败并自行拉起。
            }
        }

        /// <summary>
        /// 本程序的路径。服务不是第二个文件，而是这个 exe 的 `--service` 模式，
        /// 客户端拉起「服务」时执行的就是自己 —— 装到哪个目录都不会找错。
        /// </summary>
        public static string AppExePath
        {
            get
            {
                try
                {
                    return System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
                }
                catch
                {
                    return "";
                }
            }
        }

        /// <summary>pid 是否还活着（权限不足也算活着）。</summary>
        public static bool ProcessAlive(int pid)
        {
            if (pid <= 0)
            {
                return false;
            }
            try
            {
                System.Diagnostics.Process.GetProcessById(pid);
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>建立一条到服务的连接（不带租约语义）。</summary>
        public static NamedPipeClientStream Connect(int timeoutMs)
        {
            NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.None);
            pipe.Connect(timeoutMs);
            return pipe;
        }
    }
}
