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
        /// 确保服务在跑：能连上就直接连，连不上就拉起服务 exe 再等它。
        /// 失败返回 false 并把原因写进 error。
        /// </summary>
        public bool EnsureRunning(out string error)
        {
            error = "";
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    string hello = SendRaw("{\"v\":" + IpcContract.ProtocolVersion + ",\"cmd\":\"ping\"}", ConnectTimeoutMs, 4000);
                    if (hello != null)
                    {
                        return true;
                    }
                }
                catch
                {
                    // 连不上，下面尝试拉起。
                }

                if (attempt > 0)
                {
                    break;
                }
                string exe = IpcContract.ResolveServiceExe("");
                if (string.IsNullOrEmpty(exe))
                {
                    error = "找不到 " + IpcContract.ServiceExeName + "，请确认它和 BubbleAsk.exe 在同一目录";
                    return false;
                }
                try
                {
                    ProcessStartInfo info = new ProcessStartInfo(exe);
                    info.UseShellExecute = false;
                    info.CreateNoWindow = true;
                    Process.Start(info);
                    Log.Info("已拉起服务: " + exe);
                }
                catch (Exception spawnError)
                {
                    error = "拉起服务失败: " + spawnError.Message;
                    return false;
                }
                // 等它把管道建起来。
                for (int wait = 0; wait < 50; wait++)
                {
                    System.Threading.Thread.Sleep(200);
                    try
                    {
                        string hello = SendRaw("{\"v\":" + IpcContract.ProtocolVersion + ",\"cmd\":\"ping\"}", 800, 1500);
                        if (hello != null)
                        {
                            return true;
                        }
                    }
                    catch
                    {
                        // 还在启动。
                    }
                }
            }
            error = "服务没有在预期时间内就绪";
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

        /// <summary>发一条请求并读回一行响应；连不上返回 null。</summary>
        private string SendRaw(string json, int connectTimeoutMs, int readTimeoutMs)
        {
            using (NamedPipeClientStream pipe = IpcContract.Connect(connectTimeoutMs))
            using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false)))
            using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false)))
            {
                writer.AutoFlush = true;
                writer.Write(json + "\n");
                writer.Flush();

                // 读是阻塞的，放到任务里加超时，避免服务卡住把界面也拖死。
                Task<string> readTask = Task.Run(delegate { return reader.ReadLine(); });
                if (!readTask.Wait(readTimeoutMs))
                {
                    throw new TimeoutException("等待服务响应超时");
                }
                return readTask.Result;
            }
        }

        /// <summary>发一条命令，返回解析后的响应字典；失败返回带 stage=ipc 的结果。</summary>
        private Dictionary<string, object> Call(string command, Dictionary<string, object> payload, int readTimeoutMs)
        {
            Dictionary<string, object> request = payload == null
                ? new Dictionary<string, object>()
                : new Dictionary<string, object>(payload);
            request["v"] = IpcContract.ProtocolVersion;
            request["cmd"] = command;

            string error;
            if (!EnsureRunning(out error))
            {
                Dictionary<string, object> failed = new Dictionary<string, object>();
                failed["ok"] = false;
                failed["stage"] = "ipc";
                failed["detail"] = error;
                return failed;
            }
            try
            {
                string raw = SendRaw(Json.Stringify(request), ConnectTimeoutMs, readTimeoutMs);
                Dictionary<string, object> response = Json.ParseObject(raw);
                if (response.Count == 0)
                {
                    response = new Dictionary<string, object>();
                    response["ok"] = false;
                    response["stage"] = "ipc";
                    response["detail"] = "服务返回了空响应";
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
            catch (Exception error2)
            {
                Dictionary<string, object> failed = new Dictionary<string, object>();
                failed["ok"] = false;
                failed["stage"] = "ipc";
                failed["detail"] = "与服务的通信失败: " + error2.Message;
                _lastStatus = "ipc";
                return failed;
            }
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

        public async Task<bool> OpenAsync()
        {
            Dictionary<string, object> response = await Task.Run(delegate
            {
                return Call("open", null, QuickTimeoutMs);
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
