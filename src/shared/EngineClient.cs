using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>
    /// 服务客户端：托盘应用（以及将来的 CLI）用它驱动网页版。
    ///
    /// 每个操作开一条短连接跑一问一答；另有一条**常驻连接**作为租约，
    /// 让服务知道「这个入口还活着」。进程消失时连接自动断开，不需要注销。
    /// </summary>
    public class EngineClient : IDisposable
    {
        /// <summary>等页面的操作给足预算（冷启动要拉浏览器）。</summary>
        private const int SendTimeoutMs = 180000;
        private const int QuickTimeoutMs = 60000;
        private const int ConnectTimeoutMs = 5000;

        private readonly AppConfig _config;
        private NamedPipeClientStream _lease;
        private StreamWriter _leaseWriter;
        private StreamReader _leaseReader;
        private bool _disposed;
        private string _lastStatus = "";
        private string _probeError = "";

        public EngineClient(AppConfig config)
        {
            _config = config;
        }

        /// <summary>最近一次发送的阶段标签（服务端回传）。</summary>
        public string LastStatus
        {
            get { return _lastStatus; }
        }

        public bool HasLease
        {
            get { return _lease != null && _lease.IsConnected; }
        }

        /// <summary>
        /// 确保服务在跑：能连上就返回 true，连不上就拉起自己的 `--service` 模式再等它。
        /// 失败返回 false 并把原因写进 error。
        /// </summary>
        public bool EnsureRunning(out string error)
        {
            error = "";
            if (ServiceLooksAlive() && TryProbe(800, 1500))
            {
                return true;
            }
            if (!StartService(out error))
            {
                return false;
            }
            if (WaitReady())
            {
                return true;
            }
            error = "服务没有在预期时间内就绪";
            if (!string.IsNullOrEmpty(_probeError))
            {
                error += "（最后一次探测: " + _probeError + "）";
            }
            return false;
        }

        /// <summary>
        /// 发现文件里的 pid 还活着吗？
        ///
        /// 连管道是**阻塞**的：管道不存在时 Connect 会一直重试到超时才报错，
        /// 冷启动为此白等 5 秒。先看一眼 pid 就能把这条成本省掉。
        /// </summary>
        private static bool ServiceLooksAlive()
        {
            Dictionary<string, object> discovery = IpcContract.ReadDiscovery();
            if (discovery == null)
            {
                return false;
            }
            return IpcContract.ProcessAlive(Json.GetInt(discovery, "pid", 0));
        }

        /// <summary>ping 一次；连得上就说明服务在。</summary>
        private bool TryProbe(int connectTimeoutMs, int readTimeoutMs)
        {
            try
            {
                return SendRaw(
                    "{\"v\":" + IpcContract.ProtocolVersion + ",\"cmd\":\"ping\"}",
                    connectTimeoutMs, readTimeoutMs) != null;
            }
            catch (Exception probeError)
            {
                _probeError = probeError.GetType().Name + ": " + probeError.Message
                    + " @ " + (probeError.StackTrace ?? "").Replace("\r\n", " | ").Replace("\n", " | ");
                return false;
            }
        }

        /// <summary>拉起自己的服务模式。服务与界面是同一个文件，不存在「找错 exe」。</summary>
        private bool StartService(out string error)
        {
            error = "";
            string exe = IpcContract.AppExePath;
            if (string.IsNullOrEmpty(exe))
            {
                error = "拿不到本程序路径，无法拉起后台服务";
                return false;
            }
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(exe, IpcContract.ServiceSwitch);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                Process.Start(info);
                Log.Info("已拉起后台服务: " + exe + " " + IpcContract.ServiceSwitch);
                return true;
            }
            catch (Exception spawnError)
            {
                error = "拉起后台服务失败: " + spawnError.Message;
                return false;
            }
        }

        /// <summary>等管道建起来（最多 10 秒）。</summary>
        private bool WaitReady()
        {
            for (int wait = 0; wait < 50; wait++)
            {
                System.Threading.Thread.Sleep(200);
                if (TryProbe(800, 1500))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>建立常驻租约连接（失败只记日志，不影响单次操作）。</summary>
        public void AttachLease()
        {
            if (_lease != null)
            {
                return;
            }
            try
            {
                NamedPipeClientStream pipe = IpcContract.Connect(ConnectTimeoutMs);
                StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false));
                StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false));
                writer.AutoFlush = true;
                writer.Write("{\"v\":" + IpcContract.ProtocolVersion + ",\"cmd\":\"attach\"}\n");
                writer.Flush();
                string ack = reader.ReadLine();
                if (ack == null)
                {
                    pipe.Dispose();
                    Log.Warn("租约握手失败：服务没有回应");
                    return;
                }
                _lease = pipe;
                _leaseReader = reader;
                _leaseWriter = writer;
                Log.Info("已向服务登记租约");
            }
            catch (Exception error)
            {
                Log.Warn("建立租约失败: " + error.Message);
            }
        }

        private void ReleaseLease()
        {
            try
            {
                if (_leaseWriter != null)
                {
                    _leaseWriter.Dispose();
                }
            }
            catch
            {
            }
            try
            {
                if (_leaseReader != null)
                {
                    _leaseReader.Dispose();
                }
            }
            catch
            {
            }
            try
            {
                if (_lease != null)
                {
                    _lease.Dispose();
                }
            }
            catch
            {
            }
            _lease = null;
            _leaseWriter = null;
            _leaseReader = null;
        }

        /// <summary>
        /// 发一条请求并读回一行响应。
        ///
        /// 注意收尾顺序：写端必须在管道还开着的时候 Dispose（它要 flush），
        /// 读端一关就把管道关掉了，之后再 flush 会抛「无法访问关闭的管道」。
        /// 这里手工按 写→读→管道 的顺序释放，并且吞掉释放期的异常 ——
        /// 释放失败不该把一次成功的请求变成失败。
        /// </summary>
        private string SendRaw(string json, int connectTimeoutMs, int readTimeoutMs)
        {
            NamedPipeClientStream pipe = IpcContract.Connect(connectTimeoutMs);
            StreamWriter writer = null;
            StreamReader reader = null;
            try
            {
                writer = new StreamWriter(pipe, new UTF8Encoding(false));
                reader = new StreamReader(pipe, new UTF8Encoding(false));
                writer.AutoFlush = true;
                writer.WriteLine(json);

                // 读是阻塞的，放到任务里加超时，避免服务卡住把界面也拖死。
                Task<string> readTask = Task.Run(delegate { return reader.ReadLine(); });
                if (!readTask.Wait(readTimeoutMs))
                {
                    throw new TimeoutException("等待服务响应超时");
                }
                return readTask.Result;
            }
            finally
            {
                DisposeQuietly(writer);
                DisposeQuietly(reader);
                DisposeQuietly(pipe);
            }
        }

        /// <summary>释放时忽略异常：管道对端先关是常态，不该冒泡成调用失败。</summary>
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
                // 忽略。
            }
        }

        /// <summary>
        /// 发一条命令，返回解析后的响应字典。连不上就先拉起服务再重试一次 ——
        /// 正常路径只有一次往返，不做「先 ping 再发」的双重探测。
        /// </summary>
        private Dictionary<string, object> Call(string command, Dictionary<string, object> payload, int readTimeoutMs)
        {
            Dictionary<string, object> request = payload == null
                ? new Dictionary<string, object>()
                : new Dictionary<string, object>(payload);
            request["v"] = IpcContract.ProtocolVersion;
            request["cmd"] = command;
            string json = Json.Stringify(request);

            // 服务明确没在跑就别去 Connect：那条路要走满 5 秒超时才报错。
            if (ServiceLooksAlive())
            {
                try
                {
                    return ParseResponse(SendRaw(json, ConnectTimeoutMs, readTimeoutMs));
                }
                catch (Exception first)
                {
                    Log.Info("连接服务失败，准备拉起后台服务: " + first.Message);
                }
            }

            string startError;
            if (!StartService(out startError))
            {
                return Failure(startError);
            }
            if (!WaitReady())
            {
                return Failure("后台服务没有在预期时间内就绪" + (string.IsNullOrEmpty(_probeError) ? "" : "（最后一次探测: " + _probeError + "）"));
            }
            try
            {
                return ParseResponse(SendRaw(json, ConnectTimeoutMs, readTimeoutMs));
            }
            catch (Exception second)
            {
                return Failure("与服务的通信失败: " + second.Message);
            }
        }

        private Dictionary<string, object> ParseResponse(string raw)
        {
            Dictionary<string, object> response = Json.ParseObject(raw);
            if (response.Count == 0)
            {
                return Failure("服务返回了空响应");
            }
            string stage = Json.GetString(response, "stage", "");
            string status = Json.GetString(response, "lastStatus", "");
            if (!string.IsNullOrEmpty(stage))
            {
                _lastStatus = stage;
            }
            else if (!string.IsNullOrEmpty(status))
            {
                _lastStatus = status;
            }
            return response;
        }

        private Dictionary<string, object> Failure(string detail)
        {
            _lastStatus = "ipc";
            Dictionary<string, object> failed = new Dictionary<string, object>();

            failed["ok"] = false;
            failed["stage"] = "ipc";
            failed["detail"] = detail;
            return failed;
        }

        private static bool IsOk(Dictionary<string, object> response)
        {
            return Json.GetBool(response, "ok", false);
        }

        //#region 对外的操作面（与 ChatDriver 同名，便于替换）

        public async Task<bool> AskAsync(string prompt)
        {
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["prompt"] = prompt ?? "";
            Dictionary<string, object> response = await Task.Run(delegate
            {
                return Call("send", payload, SendTimeoutMs);
            });
            return IsOk(response);
        }

        public async Task<bool> AskWithImageAsync(string imagePath, string prompt)
        {
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["prompt"] = prompt ?? "";
            payload["imagePath"] = imagePath ?? "";
            Dictionary<string, object> response = await Task.Run(delegate
            {
                return Call("send-image", payload, SendTimeoutMs);
            });
            return IsOk(response);
        }

        /// <summary>唤起 / 收起；返回 true 表示这次是「收起」。</summary>
        public async Task<bool> ToggleAsync()
        {
            Dictionary<string, object> response = await Task.Run(delegate
            {
                return Call("toggle", null, QuickTimeoutMs);
            });
            return Json.GetBool(response, "closed", false);
        }

        public void ApplyTopMost()
        {
            Call("topmost", null, 10000);
        }

        public void Restart()
        {
            Call("restart", null, QuickTimeoutMs);
        }

        public Dictionary<string, object> Health()
        {
            return Call("health", null, 15000);
        }

        //#endregion

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            ReleaseLease();
        }
    }
}
