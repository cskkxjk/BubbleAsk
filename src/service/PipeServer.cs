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

        /// <summary>注入截图提问并发送。</summary>
        Task<bool> SendImageAsync(string imagePath, string prompt);

        /// <summary>只打开 / 复用窗口，不注入。</summary>
        Task<bool> OpenAsync();

        /// <summary>唤起 / 收起窗口；返回 true 表示这次是「收起」。</summary>
        Task<bool> ToggleAsync();

        /// <summary>按当前配置应用窗口置顶。</summary>
        void ApplyTopMost();

        /// <summary>丢弃现有连接与窗口，下次操作重新拉起浏览器。</summary>
        void Restart();

        /// <summary>当前状态快照（浏览器、端口、profile、模式等）。</summary>
        Dictionary<string, object> Health();

        /// <summary>最近一次 Send 的阶段标签。</summary>
        string LastStatus { get; }
    }

    /// <summary>
    /// 本地命名管道服务。
    ///
    /// 协议 v2：默认一连接 = 一行 JSON 请求 → 一行 JSON 响应，随后关闭；
    /// 发 `attach` 后连接转为**长期租约**，服务端一直挂着直到对端断开。
    /// 服务靠租约数量判断「还有没有入口」—— 客户端崩溃时会话自然断开，
    /// 不需要任何注销逻辑。
    ///
    /// 命令：ping / health / state / open / send / send-image / toggle / topmost / restart / attach。
    ///
    /// 管道名与发现信息由 <see cref="WriteDiscovery"/> 写到 %APPDATA%\BubbleAsk\ipc.json，
    /// 让对端不必猜测管道名，也能读到协议版本与本进程 pid。
    /// </summary>
    public class PipeServer : IDisposable
    {
        /// <summary>协议版本（见 <see cref="IpcContract"/>）。</summary>
        public const int ProtocolVersion = IpcContract.ProtocolVersion;

        /// <summary>服务版本。</summary>
        public const string AppVersion = IpcContract.AppVersion;

        private const int MaxConcurrentInstances = 8;
        private const int BufferSize = 64 * 1024;

        private readonly IIpcHost _host;
        private CancellationTokenSource _cancellation;
        private Task _loop;
        private bool _disposed;

        /// <summary>当前持有的长期租约数量（每条 attach 连接算一个）。</summary>
        private int _leaseCount;
        private readonly object _leaseGate = new object();

        /// <summary>租约数从 0 变为 1：有客户端接入了。</summary>
        public event Action LeaseAttached;

        /// <summary>租约数从 1 变为 0：所有入口都走了，可以进入宽限期。</summary>
        public event Action LeasesDrained;

        /// <summary>当前租约数量。</summary>
        public int LeaseCount
        {
            get
            {
                lock (_leaseGate)
                {
                    return _leaseCount;
                }
            }
        }

        private void AddLease()
        {
            int now;
            lock (_leaseGate)
            {
                _leaseCount += 1;
                now = _leaseCount;
            }
            if (now == 1)
            {
                Action handler = LeaseAttached;
                if (handler != null)
                {
                    handler();
                }
            }
        }

        private void RemoveLease()
        {
            int now;
            lock (_leaseGate)
            {
                if (_leaseCount > 0)
                {
                    _leaseCount -= 1;
                }
                now = _leaseCount;
            }
            if (now == 0)
            {
                Action handler = LeasesDrained;
                if (handler != null)
                {
                    handler();
                }
            }
        }

        public PipeServer(IIpcHost host)
        {
            if (host == null)
            {
                throw new ArgumentNullException("host");
            }
            _host = host;
        }

        /// <summary>管道名（见 <see cref="IpcContract"/>）。</summary>
        public static string PipeName
        {
            get { return IpcContract.PipeName; }
        }

        /// <summary>发现文件路径（见 <see cref="IpcContract"/>）。</summary>
        public static string DiscoveryPath
        {
            get { return IpcContract.DiscoveryPath; }
        }

        /// <summary>把发现信息写下来，供所有客户端读取（委托给共享契约）。</summary>
        public static void WriteDiscovery(string exePath)
        {
            IpcContract.WriteDiscovery(exePath);
        }

        /// <summary>进程退出时把 pid 置 0，但保留 exe 路径（委托给共享契约）。</summary>
        public static void MarkStopped()
        {
            IpcContract.MarkStopped();
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

        /// <summary>一条请求的处理结果。</summary>
        private sealed class DispatchResult
        {
            public Dictionary<string, object> Response;
            /// <summary>true 表示这条连接转成长期租约，不要关闭。</summary>
            public bool KeepOpen;
        }

        private async Task HandleAsync(NamedPipeServerStream pipe, CancellationToken token)
        {
            bool leased = false;
            try
            {
                using (pipe)
                using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, BufferSize, true))
                using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), BufferSize, true))
                {
                    while (true)
                    {
                        string line = await reader.ReadLineAsync().ConfigureAwait(false);
                        // 对端关闭（正常退出、崩溃、被杀）都会走到这里。
                        if (line == null)
                        {
                            break;
                        }
                        DispatchResult result = await DispatchAsync(line, token).ConfigureAwait(false);
                        if (result == null)
                        {
                            break;
                        }
                        if (result.Response != null)
                        {
                            writer.Write(Json.Stringify(result.Response));
                            writer.Write('\n');
                            writer.Flush();
                        }
                        if (result.KeepOpen)
                        {
                            if (!leased)
                            {
                                leased = true;
                                AddLease();
                                Log.Info("客户端接入，当前搭配租约: " + LeaseCount);
                            }
                            continue;
                        }
                        // 普通请求：一问一答即断开。
                        if (!leased)
                        {
                            break;
                        }
                    }
                }
            }
            catch (Exception error)
            {
                Log.Warn("处理管道请求失败: " + error.Message);
            }
            finally
            {
                if (leased)
                {
                    RemoveLease();
                    Log.Info("客户端断开，剩余租约: " + LeaseCount);
                }
            }
        }

        private static DispatchResult Reply(Dictionary<string, object> response)
        {
            return new DispatchResult { Response = response, KeepOpen = false };
        }

        private async Task<DispatchResult> DispatchAsync(string line, CancellationToken token)
        {
            Dictionary<string, object> request = Json.ParseObject(line);
            string command = Json.GetString(request, "cmd", "");
            if (command.Length == 0)
            {
                return Reply(Fail("missing-cmd", "请求里没有 cmd 字段"));
            }

            // 版本不一致就别硬撑：调用方按这个字段提示"请升级 Bubble Ask"。
            int version = Json.GetInt(request, "v", 0);
            if (version != ProtocolVersion)
            {
                Dictionary<string, object> mismatch = Fail("version",
                    "协议版本不匹配（对端 " + version + "，本端 " + ProtocolVersion + "）");
                mismatch["version"] = ProtocolVersion;
                mismatch["app"] = AppVersion;
                return Reply(mismatch);
            }

            // attach：这条连接从此转为长期租约，直到对端断开。
            if (command == "attach")
            {
                Dictionary<string, object> attached = Ok();
                attached["version"] = ProtocolVersion;
                attached["app"] = AppVersion;
                attached["leases"] = LeaseCount;
                return new DispatchResult { Response = attached, KeepOpen = true };
            }

            if (command == "ping")
            {
                Dictionary<string, object> pong = Ok();
                pong["version"] = ProtocolVersion;
                pong["app"] = AppVersion;
                pong["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
                pong["leases"] = LeaseCount;
                return Reply(pong);
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
                health["leases"] = LeaseCount;
                return Reply(health);
            }

            if (command == "open")
            {
                if (!_host.TryBegin("管道打开窗口"))
                {
                    return Reply(Fail("busy", "上一个操作还没结束，请稍候重试"));
                }
                try
                {
                    bool opened = await _host.OpenAsync().ConfigureAwait(false);
                    Dictionary<string, object> result = Ok();
                    result["ok"] = opened;
                    result["stage"] = opened ? "opened" : "launch";
                    result["detail"] = opened ? "窗口已就绪" : "窗口没能打开";
                    return Reply(result);
                }
                finally
                {
                    _host.End();
                }
            }

            if (command == "toggle")
            {
                if (!_host.TryBegin("管道唤起/收起"))
                {
                    return Reply(Fail("busy", "上一个操作还没结束，请稍候重试"));
                }
                try
                {
                    bool closed = await _host.ToggleAsync().ConfigureAwait(false);
                    Dictionary<string, object> result = Ok();
                    result["ok"] = true;
                    result["closed"] = closed;
                    result["detail"] = closed ? "已收起窗口" : "窗口已在前台";
                    return Reply(result);
                }
                finally
                {
                    _host.End();
                }
            }

            if (command == "topmost")
            {
                _host.ApplyTopMost();
                return Reply(Ok());
            }

            if (command == "restart")
            {
                if (!_host.TryBegin("管道重启会话"))
                {
                    return Reply(Fail("busy", "上一个操作还没结束，请稍候重试"));
                }
                try
                {
                    _host.Restart();
                    Dictionary<string, object> result = Ok();
                    result["detail"] = "会话已重启，下次操作会重新拉起浏览器";
                    return Reply(result);
                }
                finally
                {
                    _host.End();
                }
            }

            if (command == "send" || command == "send-image")
            {
                string prompt = Json.GetString(request, "prompt", "");
                if (prompt.Trim().Length == 0)
                {
                    return Reply(Fail("fill", "prompt 为空，没有可发送的内容"));
                }
                string imagePath = Json.GetString(request, "imagePath", "");
                if (command == "send-image" && imagePath.Trim().Length == 0)
                {
                    return Reply(Fail("fill", "imagePath 为空"));
                }
                if (!_host.TryBegin("管道发送"))
                {
                    return Reply(Fail("busy", "上一个操作还没结束，请稍候重试"));
                }
                try
                {
                    bool sent = command == "send-image"
                        ? await _host.SendImageAsync(imagePath, prompt).ConfigureAwait(false)
                        : await _host.SendAsync(prompt).ConfigureAwait(false);
                    Dictionary<string, object> result = Ok();
                    result["ok"] = sent;
                    result["stage"] = _host.LastStatus;
                    result["detail"] = sent ? "已发送到网页版" : "未能确认发送，请在窗口里手动回车";
                    return Reply(result);
                }
                finally
                {
                    _host.End();
                }
            }

            return Reply(Fail("unknown-cmd", "不认识的命令: " + command));
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
