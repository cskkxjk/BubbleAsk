using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>
    /// 托盘应用提供给外部进程（例如 DSH 插件）的能力。
    ///
    /// 单独抽出来是为了让自测程序能塞一个假宿主，不必真的起一套浏览器与 CDP。
    /// </summary>
    public interface IIpcHost
    {
        /// <summary>抢占一次性操作占位；返回 false 表示已有操作在进行。</summary>
        bool TryBegin(string what);

        /// <summary>释放占位。</summary>
        void End();

        /// <summary>注入并发送（走网页版 CDP），返回是否确认发出。</summary>
        Task<bool> SendAsync(string prompt);

        /// <summary>只打开 / 复用窗口，不注入。</summary>
        Task<bool> OpenAsync();

        /// <summary>当前状态快照（浏览器、端口、profile、模式等）。</summary>
        Dictionary<string, object> Health();

        /// <summary>最近一次 Send 的阶段标签。</summary>
        string LastStatus { get; }
    }

    /// <summary>
    /// 本地命名管道服务。
    ///
    /// 协议：一连接 = 一行 JSON 请求 → 一行 JSON 响应，然后关闭。
    /// 命令：ping / health / open / send / state。
    ///
    /// 管道名与发现信息由 <see cref="WriteDiscovery"/> 写到 %APPDATA%\BubbleAsk\ipc.json，
    /// 让对端不必猜测管道名，也能读到协议版本与本进程 pid。
    /// </summary>
    public class PipeServer : IDisposable
    {
        /// <summary>协议版本。对端必须与之一致，否则应提示升级 exe。</summary>
        public const int ProtocolVersion = 1;

        /// <summary>应用版本。改动协议时同步加一。</summary>
        public const string AppVersion = "1.1.0";

        private const int MaxConcurrentInstances = 8;
        private const int BufferSize = 64 * 1024;

        private readonly IIpcHost _host;
        private CancellationTokenSource _cancellation;
        private Task _loop;
        private bool _disposed;

        public PipeServer(IIpcHost host)
        {
            if (host == null)
            {
                throw new ArgumentNullException("host");
            }
            _host = host;
        }

        /// <summary>管道名：固定前缀 + 当前用户名，避免不同登录会话之间串台。</summary>
        public static string PipeName
        {
            get { return "BubbleAsk.Ipc.v1." + Sanitize(Environment.UserName); }
        }

        /// <summary>发现文件路径，与 AppConfig.DataDir 保持一致。</summary>
        public static string DiscoveryPath
        {
            get { return Path.Combine(AppConfig.DataDir, "ipc.json"); }
        }

        /// <summary>用户名可能含非 ASCII，压成管道名安全字符。</summary>
        private static string Sanitize(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "default";
            }
            StringBuilder builder = new StringBuilder(value.Length);
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

        /// <summary>把发现信息写下来，供对端读取（管道名、版本、pid、exe 路径）。</summary>
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
        /// 进程退出时刻意**不删**发现文件。
        ///
        /// 它同时是「本应用装在哪」的记录（exe 字段），对端靠它在本应用没运行时
        /// 也知道该拉起哪个程序；是否在跑由 pid 存活 + ping 探活判断。
        /// </summary>
        public static void MarkStopped()
        {
            try
            {
                if (!File.Exists(DiscoveryPath))
                {
                    return;
                }
                Dictionary<string, object> data = Json.ParseObject(File.ReadAllText(DiscoveryPath));
                data["pid"] = 0;
                File.WriteAllText(DiscoveryPath, Json.Stringify(data));
            }
            catch
            {
                // 标记失败不影响功能：对端探活会失败并自行拉起。
            }
        }

        public void Start()
        {
            if (_loop != null)
            {
                return;
            }
            _cancellation = new CancellationTokenSource();
            _loop = Task.Run(delegate { return AcceptLoopAsync(_cancellation.Token); });
            Log.Info("管道服务已启动: " + PipeName);
        }

        private NamedPipeServerStream CreatePipe()
        {
            try
            {
                // 只允许当前登录用户连接；显式拒绝网络身份，避免暴露到局域网。
                PipeSecurity security = new PipeSecurity();
                WindowsIdentity identity = WindowsIdentity.GetCurrent();
                if (identity != null && identity.User != null)
                {
                    security.AddAccessRule(new PipeAccessRule(
                        identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
                }
                SecurityIdentifier network = new SecurityIdentifier(WellKnownSidType.NetworkSid, null);
                security.AddAccessRule(new PipeAccessRule(
                    network, PipeAccessRights.FullControl, AccessControlType.Deny));
                return new NamedPipeServerStream(PipeName, PipeDirection.InOut, MaxConcurrentInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, BufferSize, BufferSize, security);
            }
            catch (Exception error)
            {
                // ACL 在个别环境下会失败，但不该让整个应用起不来。
                Log.Warn("管道 ACL 设置失败，退回默认权限: " + error.Message);
                return new NamedPipeServerStream(PipeName, PipeDirection.InOut, MaxConcurrentInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, BufferSize, BufferSize);
            }
        }

        private async Task AcceptLoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                NamedPipeServerStream pipe = null;
                bool retryLater = false;
                try
                {
                    pipe = CreatePipe();
                    await pipe.WaitForConnectionAsync(token).ConfigureAwait(false);
                    NamedPipeServerStream connected = pipe;
                    pipe = null;
                    // 每个连接单开一个任务：send 很慢（要等页面渲染），
                    // 但 ping / health 不该被它挡住。串行化由宿主的 TryBegin 负责。
                    // 赋值给局部变量而不是裸调用：C# 5 下裸调用未 await 会报 CS4014。
                    Task handling = Task.Run(delegate { return HandleAsync(connected, token); });
                    GC.KeepAlive(handling);
                }
                catch (OperationCanceledException)
                {
                    DisposeQuietly(pipe);
                    break;
                }
                catch (Exception error)
                {
                    DisposeQuietly(pipe);
                    retryLater = true;
                    if (token.IsCancellationRequested)
                    {
                        break;
                    }
                    Log.Warn("管道接受连接失败: " + error.Message);
                }
                // C# 5 不允许在 catch 块里 await，所以退避放到 catch 之外。
                if (retryLater)
                {
                    await Task.Delay(500).ConfigureAwait(false);
                }
            }
        }

        private static void DisposeQuietly(IDisposable target)
        {
            if (target == null)
            {
                return;
            }
            try
            {
                target.Dispose();
            }
            catch
            {
                // 关闭失败无所谓，进程退出时会回收。
            }
        }

        private async Task HandleAsync(NamedPipeServerStream pipe, CancellationToken token)
        {
            try
            {
                using (pipe)
                using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, BufferSize, true))
                using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), BufferSize, true))
                {
                    string line = await reader.ReadLineAsync().ConfigureAwait(false);
                    Dictionary<string, object> response = await DispatchAsync(line, token).ConfigureAwait(false);
                    writer.Write(Json.Stringify(response));
                    writer.Write('\n');
                    writer.Flush();
                }
            }
            catch (Exception error)
            {
                Log.Warn("处理管道请求失败: " + error.Message);
            }
        }

        private async Task<Dictionary<string, object>> DispatchAsync(string line, CancellationToken token)
        {
            Dictionary<string, object> request = Json.ParseObject(line);
            string command = Json.GetString(request, "cmd", "");
            if (command.Length == 0)
            {
                return Fail("missing-cmd", "请求里没有 cmd 字段");
            }

            // 版本不一致就别硬撑：调用方按这个字段提示"请升级 Bubble Ask"。
            int version = Json.GetInt(request, "v", 0);
            if (version != ProtocolVersion)
            {
                Dictionary<string, object> mismatch = Fail("version",
                    "协议版本不匹配（对端 " + version + "，本端 " + ProtocolVersion + "）");
                mismatch["version"] = ProtocolVersion;
                mismatch["app"] = AppVersion;
                return mismatch;
            }

            if (command == "ping")
            {
                Dictionary<string, object> pong = Ok();
                pong["version"] = ProtocolVersion;
                pong["app"] = AppVersion;
                pong["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
                return pong;
            }

            if (command == "health" || command == "state")
            {
                Dictionary<string, object> health = Ok();
                foreach (KeyValuePair<string, object> pair in _host.Health())
                {
                    health[pair.Key] = pair.Value;
                }
                health["version"] = ProtocolVersion;
                health["app"] = AppVersion;
                return health;
            }

            if (command == "open")
            {
                if (!_host.TryBegin("管道打开窗口"))
                {
                    return Fail("busy", "上一个操作还没结束，请稍候重试");
                }
                try
                {
                    bool opened = await _host.OpenAsync().ConfigureAwait(false);
                    Dictionary<string, object> result = Ok();
                    result["ok"] = opened;
                    result["stage"] = opened ? "opened" : "launch";
                    result["detail"] = opened ? "窗口已就绪" : "窗口没能打开";
                    return result;
                }
                finally
                {
                    _host.End();
                }
            }

            if (command == "send")
            {
                string prompt = Json.GetString(request, "prompt", "");
                if (prompt.Trim().Length == 0)
                {
                    return Fail("fill", "prompt 为空，没有可发送的内容");
                }
                if (!_host.TryBegin("管道发送"))
                {
                    return Fail("busy", "上一个操作还没结束，请稍候重试");
                }
                try
                {
                    bool sent = await _host.SendAsync(prompt).ConfigureAwait(false);
                    Dictionary<string, object> result = Ok();
                    result["ok"] = sent;
                    result["stage"] = _host.LastStatus;
                    result["detail"] = sent ? "已发送到网页版" : "未能确认发送，请在窗口里手动回车";
                    return result;
                }
                finally
                {
                    _host.End();
                }
            }

            return Fail("unknown-cmd", "不认识的命令: " + command);
        }

        private static Dictionary<string, object> Ok()
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = true;
            return result;
        }

        private static Dictionary<string, object> Fail(string stage, string detail)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = false;
            result["stage"] = stage;
            result["detail"] = detail;
            return result;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            try
            {
                if (_cancellation != null)
                {
                    _cancellation.Cancel();
                }
            }
            catch
            {
                // 取消失败不影响后续回收。
            }
            try
            {
                if (_loop != null)
                {
                    _loop.Wait(1000);
                }
            }
            catch
            {
                // 循环里的异常已经在内部记过日志。
            }
            try
            {
                if (_cancellation != null)
                {
                    _cancellation.Dispose();
                }
            }
            catch
            {
                // 忽略。
            }
            MarkStopped();
            Log.Info("管道服务已停止");
        }
    }
}
