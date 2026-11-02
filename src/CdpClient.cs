using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>通过 Chrome DevTools Protocol 操作 Edge 里的页面。</summary>
    public class CdpClient : IDisposable
    {
        // 查 /json/list 的单次请求上限，避免卡住时把整个 timeoutMs 吞掉。
        private const int TargetListRequestTimeoutMs = 3000;
        // 目标列表轮询间隔（原来是硬编码的 300 毫秒）。
        private const int TargetPollIntervalMs = 300;
        // 单条 WebSocket 消息允许攒下的最大字节数，防止异常数据把内存撑爆。
        private const int MaxMessageBytes = 32 * 1024 * 1024;
        // 调用方传 0 或负数时的兜底超时。
        private const int DefaultTimeoutMs = 15000;

        // 单次查询请求自带 3 秒超时；FindTargetAsync 的整体预算由 ConnectAsync 控制。
        private readonly HttpClient _http = CreateHttpClient();
        private readonly Dictionary<int, TaskCompletionSource<Dictionary<string, object>>> _pending =
            new Dictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
        // 保护 _pending 与 _nextId：UI 线程写入、接收线程取走，必须同一把锁。
        private readonly object _pendingGate = new object();
        // 发送队列：同一时刻只允许一个 SendAsync，串行化靠 _sendTail 串起来。
        private readonly object _sendGate = new object();
        private Task _sendTail = Task.FromResult(0);
        private ClientWebSocket _socket;
        private CancellationTokenSource _cts;
        private Task _receiveLoop;
        private int _nextId;
        private string _targetUrl = "";
        private int _disposed;

        private static HttpClient CreateHttpClient()
        {
            HttpClient client = new HttpClient();
            // 每请求超时：timeoutMs 只用于整体预算，单次请求不能无限等。
            client.Timeout = TimeSpan.FromMilliseconds(TargetListRequestTimeoutMs);
            return client;
        }

        public string TargetUrl
        {
            get { return _targetUrl; }
        }

        public bool IsConnected
        {
            get { return _socket != null && _socket.State == WebSocketState.Open; }
        }

        public async Task<string> ConnectAsync(int port, string urlPrefix, int timeoutMs)
        {
            if (timeoutMs <= 0)
            {
                timeoutMs = DefaultTimeoutMs;
            }
            // 总预算：查目标 + 握手共用 timeoutMs。
            Stopwatch budget = Stopwatch.StartNew();
            string webSocketUrl = await FindTargetAsync(port, urlPrefix, RemainingMs(budget, timeoutMs));
            if (string.IsNullOrEmpty(webSocketUrl))
            {
                throw new TimeoutException("没有找到可调试的页面（端口 " + port + "）");
            }
            int connectBudget = RemainingMs(budget, timeoutMs);
            if (connectBudget <= 0)
            {
                throw new TimeoutException("等待 CDP 目标已用尽全部超时（端口 " + port + "）");
            }

            _cts = new CancellationTokenSource();
            ClientWebSocket socket = new ClientWebSocket();
            socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(10);
            _socket = socket;

            // 握手阶段原来只受 Dispose 取消，卡住就永久阻塞，这里加硬超时。
            Task connectTask = socket.ConnectAsync(new Uri(webSocketUrl), _cts.Token);
            Task delayTask = Task.Delay(connectBudget);
            Task finished = await Task.WhenAny(connectTask, delayTask);
            if (finished != connectTask)
            {
                Log.Warn("CDP 握手超时（" + connectBudget + " 毫秒）: " + webSocketUrl);
                AbortSocket();
                throw new TimeoutException("连接 CDP 超时: " + webSocketUrl);
            }
            try
            {
                await connectTask;
            }
            catch (Exception error)
            {
                AbortSocket();
                Log.Error("CDP 连接失败: " + webSocketUrl, error);
                throw;
            }

            _receiveLoop = Task.Run(new Func<Task>(ReceiveLoop));
            Log.Info("CDP 已连接: " + webSocketUrl);
            return webSocketUrl;
        }

        private async Task<string> FindTargetAsync(int port, string urlPrefix, int timeoutMs)
        {
            if (timeoutMs <= 0)
            {
                return null;
            }
            Stopwatch clock = Stopwatch.StartNew();
            while (true)
            {
                try
                {
                    string json = await _http.GetStringAsync("http://127.0.0.1:" + port + "/json/list");
                    List<object> items = Json.ParseArray(json);
                    for (int i = 0; i < items.Count; i++)
                    {
                        Dictionary<string, object> item = items[i] as Dictionary<string, object>;
                        if (item == null)
                        {
                            continue;
                        }
                        string type = Json.GetString(item, "type", "");
                        string url = Json.GetString(item, "url", "");
                        if (type == "page" && url.StartsWith(urlPrefix, StringComparison.OrdinalIgnoreCase))
                        {
                            _targetUrl = url;
                            return Json.GetString(item, "webSocketDebuggerUrl", "");
                        }
                    }
                }
                catch (Exception error)
                {
                    Log.Warn("查询 CDP 目标失败: " + error.Message);
                }
                int remaining = RemainingMs(clock, timeoutMs);
                if (remaining <= 0)
                {
                    break;
                }
                await Task.Delay(Math.Min(remaining, TargetPollIntervalMs));
            }
            return null;
        }

        /// <summary>总预算里还剩多少毫秒（已用尽时返回 0）。</summary>
        private static int RemainingMs(Stopwatch clock, int totalMs)
        {
            if (clock == null)
            {
                return totalMs;
            }
            long used = clock.ElapsedMilliseconds;
            if (used >= totalMs)
            {
                return 0;
            }
            return (int)(totalMs - used);
        }

        public async Task<string> EvaluateAsync(string expression, int timeoutMs)
        {
            Dictionary<string, object> parameters = new Dictionary<string, object>();
            parameters["expression"] = expression;
            parameters["returnByValue"] = true;
            parameters["awaitPromise"] = true;
            parameters["userGesture"] = true;

            Dictionary<string, object> response = await CallAsync("Runtime.evaluate", parameters, timeoutMs);
            if (response == null)
            {
                return null;
            }
            object exception;
            if (response.TryGetValue("exceptionDetails", out exception) && exception != null)
            {
                Log.Warn("页面脚本抛错: " + Json.Stringify(exception));
                return null;
            }
            Dictionary<string, object> result = response.ContainsKey("result")
                ? response["result"] as Dictionary<string, object>
                : null;
            if (result == null)
            {
                return null;
            }
            Dictionary<string, object> payload = result.ContainsKey("result")
                ? result["result"] as Dictionary<string, object>
                : null;
            if (payload == null)
            {
                return null;
            }
            object value;
            if (payload.TryGetValue("value", out value))
            {
                return value == null ? null : Convert.ToString(value);
            }
            object description;
            if (payload.TryGetValue("description", out description))
            {
                return Convert.ToString(description);
            }
            return null;
        }

        public async Task NavigateAsync(string url, int timeoutMs)
        {
            Dictionary<string, object> parameters = new Dictionary<string, object>();
            parameters["url"] = url;
            await CallAsync("Page.navigate", parameters, timeoutMs);
            _targetUrl = url;
        }

        /// <summary>
        /// 求值并保留对象引用，返回 objectId（对象为 null 时返回 null）。
        /// 需要把 JS 里的真实 DOM 节点交给其它 CDP 命令时用，比如往文件框里塞文件。
        /// </summary>
        public async Task<string> EvaluateHandleAsync(string expression, int timeoutMs)
        {
            Dictionary<string, object> parameters = new Dictionary<string, object>();
            parameters["expression"] = expression;
            parameters["returnByValue"] = false;
            parameters["awaitPromise"] = true;
            parameters["userGesture"] = true;

            Dictionary<string, object> response = await CallAsync("Runtime.evaluate", parameters, timeoutMs);
            Dictionary<string, object> result = GetDictionary(response, "result");
            Dictionary<string, object> payload = GetDictionary(result, "result");
            if (payload == null)
            {
                return null;
            }
            object objectId;
            if (!payload.TryGetValue("objectId", out objectId) || objectId == null)
            {
                return null;
            }
            string text = Convert.ToString(objectId);
            return string.IsNullOrEmpty(text) ? null : text;
        }

        public async Task EnableDomAsync(int timeoutMs)
        {
            await CallAsync("DOM.enable", new Dictionary<string, object>(), timeoutMs);
        }

        /// <summary>把本地文件直接交给页面上的 file input，不需要剪贴板和窗口焦点。</summary>
        public async Task<bool> SetFileInputFilesAsync(string objectId, string filePath, int timeoutMs)
        {
            if (string.IsNullOrEmpty(objectId) || string.IsNullOrEmpty(filePath))
            {
                return false;
            }
            Dictionary<string, object> parameters = new Dictionary<string, object>();
            parameters["files"] = new object[] { filePath };
            parameters["objectId"] = objectId;
            Dictionary<string, object> response = await CallAsync("DOM.setFileInputFiles", parameters, timeoutMs);
            return response != null && !response.ContainsKey("error");
        }

        /// <summary>
        /// 通过 CDP 的 Input 域发一次可信 Enter（keyDown + keyUp），
        /// 不依赖窗口焦点，也不会像 window.event 那样被页面判为不可信。
        /// 两步都必须没有 error 才算成功。
        /// </summary>
        public async Task<bool> DispatchEnterAsync(int timeoutMs)
        {
            try
            {
                if (!await DispatchKeyEventAsync("keyDown", "Enter", "Enter", "\r", timeoutMs))
                {
                    return false;
                }
                return await DispatchKeyEventAsync("keyUp", "Enter", "Enter", null, timeoutMs);
            }
            catch (Exception error)
            {
                // 调用方（ChatDriver）按 false 走发送按钮兜底，这里不再外抛。
                Log.Warn("CDP 发送 Enter 失败: " + error.Message);
                return false;
            }
        }

        /// <summary>发一次 Input.dispatchKeyEvent，返回是否没有 error 字段。</summary>
        private async Task<bool> DispatchKeyEventAsync(string type, string key, string code, string text, int timeoutMs)
        {
            Dictionary<string, object> parameters = new Dictionary<string, object>();
            parameters["type"] = type;
            parameters["key"] = key;
            parameters["code"] = code;
            parameters["windowsVirtualKeyCode"] = 13;
            parameters["nativeVirtualKeyCode"] = 13;
            // keyUp 不带 text，否则某些页面会当成两次输入。
            if (!string.IsNullOrEmpty(text))
            {
                parameters["text"] = text;
            }
            Dictionary<string, object> response = await CallAsync("Input.dispatchKeyEvent", parameters, timeoutMs);
            return response != null && !response.ContainsKey("error");
        }

        private static Dictionary<string, object> GetDictionary(Dictionary<string, object> data, string key)
        {
            object value;
            if (data == null || !data.TryGetValue(key, out value))
            {
                return null;
            }
            return value as Dictionary<string, object>;
        }

        private async Task<Dictionary<string, object>> CallAsync(string method, Dictionary<string, object> parameters, int timeoutMs)
        {
            ClientWebSocket socket = _socket;
            if (socket == null || socket.State != WebSocketState.Open)
            {
                throw new InvalidOperationException("CDP 未连接");
            }
            if (timeoutMs <= 0)
            {
                timeoutMs = DefaultTimeoutMs;
            }

            int id;
            TaskCompletionSource<Dictionary<string, object>> tcs = new TaskCompletionSource<Dictionary<string, object>>();
            lock (_pendingGate)
            {
                // id 递增和登记放在同一把锁里，避免并发时撞号覆盖别人的 TCS。
                _nextId++;
                id = _nextId;
                _pending[id] = tcs;
            }

            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            message["method"] = method;
            message["params"] = parameters;
            string json = Json.Stringify(message);
            byte[] bytes = Encoding.UTF8.GetBytes(json);

            try
            {
                // ClientWebSocket 同时只允许一个 SendAsync，这里走串行发送队列。
                await SendSerializedAsync(socket, bytes);
            }
            catch (Exception error)
            {
                RemovePending(id);
                Log.Warn("CDP 发送失败(" + method + "): " + error.Message);
                throw;
            }

            Task finished = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
            if (finished != tcs.Task)
            {
                if (tcs.Task.Status == TaskStatus.RanToCompletion)
                {
                    // 回包和超时几乎同时到达时，优先采用真实回包。
                    return tcs.Task.Result;
                }
                RemovePending(id);
                // 注销后迟到的回包会找不到 id；让这条 TCS 作废并保证异常被观察。
                tcs.TrySetCanceled();
                Observe(tcs.Task);
                throw new TimeoutException("CDP 调用超时: " + method);
            }
            return await tcs.Task;
        }

        /// <summary>
        /// 串行化发送：每个调用在锁内排队，等前一个发送结束再发，
        /// 锁只用来交换队尾，不覆盖真正的 SendAsync。
        /// </summary>
        private async Task SendSerializedAsync(ClientWebSocket socket, byte[] bytes)
        {
            Task previous;
            TaskCompletionSource<int> slot = new TaskCompletionSource<int>();
            lock (_sendGate)
            {
                previous = _sendTail;
                _sendTail = slot.Task;
            }
            try
            {
                try
                {
                    await previous;
                }
                catch (Exception)
                {
                    // 前一个发送的结果与本条无关，不能挡住队列。
                }
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CurrentToken());
            }
            finally
            {
                // 无论成功、失败还是取消，都要放行后面排队的发送。
                slot.TrySetResult(0);
            }
        }

        /// <summary>吞掉不再被 await 的任务异常，避免未观察异常。</summary>
        private static void Observe(Task task)
        {
            if (task == null)
            {
                return;
            }
            task.ContinueWith(delegate(Task completed)
            {
                Exception ignored = completed.Exception;
            }, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
        }

        private void RemovePending(int id)
        {
            lock (_pendingGate)
            {
                _pending.Remove(id);
            }
        }

        /// <summary>连接不可用时把所有未决调用立刻结束，别让调用方干等超时。</summary>
        private void FailAllPending(Exception error)
        {
            if (error == null)
            {
                error = new InvalidOperationException("CDP 连接不可用");
            }
            List<TaskCompletionSource<Dictionary<string, object>>> orphans =
                new List<TaskCompletionSource<Dictionary<string, object>>>();
            lock (_pendingGate)
            {
                foreach (KeyValuePair<int, TaskCompletionSource<Dictionary<string, object>>> pair in _pending)
                {
                    orphans.Add(pair.Value);
                }
                _pending.Clear();
            }
            if (orphans.Count == 0)
            {
                return;
            }
            Log.Warn("CDP 结束未完成调用 " + orphans.Count + " 个: " + error.Message);
            for (int i = 0; i < orphans.Count; i++)
            {
                orphans[i].TrySetException(error);
            }
        }

        private CancellationToken CurrentToken()
        {
            CancellationTokenSource cts = _cts;
            if (cts == null)
            {
                return CancellationToken.None;
            }
            try
            {
                return cts.Token;
            }
            catch (ObjectDisposedException)
            {
                return CancellationToken.None;
            }
        }

        private bool IsCancellationRequested()
        {
            CancellationTokenSource cts = _cts;
            if (cts == null)
            {
                return true;
            }
            try
            {
                return cts.IsCancellationRequested;
            }
            catch (ObjectDisposedException)
            {
                return true;
            }
        }

        /// <summary>放弃当前连接：取消 token 并释放 socket。</summary>
        private void AbortSocket()
        {
            try
            {
                if (_cts != null)
                {
                    _cts.Cancel();
                }
            }
            catch
            {
            }
            ClientWebSocket socket = _socket;
            _socket = null;
            try
            {
                if (socket != null)
                {
                    socket.Dispose();
                }
            }
            catch
            {
            }
        }

        private async Task ReceiveLoop()
        {
            ClientWebSocket socket = _socket;
            if (socket == null)
            {
                return;
            }
            byte[] buffer = new byte[16384];
            // 累积整条消息的字节，EndOfMessage 时才解码：
            // 否则多字节汉字会被 16KB 分片从中间切断，变成乱码。
            MemoryStream accumulated = new MemoryStream();
            bool overflowed = false;
            try
            {
                while (socket.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), CurrentToken());
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Log.Warn("CDP 连接被对端关闭: " + result.CloseStatus);
                        break;
                    }
                    if (result.Count > 0)
                    {
                        if (accumulated.Length + result.Count > MaxMessageBytes)
                        {
                            overflowed = true;
                        }
                        else
                        {
                            accumulated.Write(buffer, 0, result.Count);
                        }
                    }
                    if (!result.EndOfMessage)
                    {
                        continue;
                    }
                    if (overflowed)
                    {
                        Log.Warn("CDP 消息超过 " + MaxMessageBytes + " 字节，已丢弃");
                    }
                    else if (accumulated.Length > 0)
                    {
                        string text = Encoding.UTF8.GetString(accumulated.ToArray());
                        HandleMessage(text);
                    }
                    accumulated.SetLength(0);
                    overflowed = false;
                }
            }
            catch (Exception error)
            {
                if (!IsCancellationRequested())
                {
                    Log.Warn("CDP 接收循环结束: " + error.Message);
                }
            }
            finally
            {
                try
                {
                    accumulated.Dispose();
                }
                catch
                {
                }
                // 接收循环没了就再也不会有人回包，让未决调用立刻失败。
                if (!IsCancellationRequested())
                {
                    FailAllPending(new InvalidOperationException("CDP 接收循环已退出，未完成的调用被中止"));
                }
            }
        }

        private void HandleMessage(string text)
        {
            Dictionary<string, object> message = Json.ParseObject(text);
            if (message == null || !message.ContainsKey("id"))
            {
                return;
            }
            int id;
            try
            {
                id = Convert.ToInt32(message["id"]);
            }
            catch
            {
                return;
            }
            TaskCompletionSource<Dictionary<string, object>> tcs = null;
            lock (_pendingGate)
            {
                if (_pending.TryGetValue(id, out tcs))
                {
                    _pending.Remove(id);
                }
            }
            if (tcs == null)
            {
                return;
            }
            if (message.ContainsKey("error"))
            {
                Log.Warn("CDP 返回错误: " + Json.Stringify(message["error"]));
            }
            tcs.TrySetResult(message);
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }
            try
            {
                if (_cts != null)
                {
                    _cts.Cancel();
                }
            }
            catch
            {
            }
            // 先结束未决调用，再拆连接，调用方不会干等超时。
            FailAllPending(new ObjectDisposedException("CdpClient", "CDP 客户端已释放，未完成的调用被中止"));
            AbortSocket();
            try
            {
                _http.Dispose();
            }
            catch
            {
            }
        }
    }
}
