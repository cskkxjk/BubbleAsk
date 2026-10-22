using System;
using System.Collections.Generic;
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
        private readonly HttpClient _http = new HttpClient();
        private readonly Dictionary<int, TaskCompletionSource<Dictionary<string, object>>> _pending =
            new Dictionary<int, TaskCompletionSource<Dictionary<string, object>>>();
        private ClientWebSocket _socket;
        private CancellationTokenSource _cts;
        private Task _receiveLoop;
        private int _nextId;
        private string _targetUrl = "";

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
            string webSocketUrl = await FindTargetAsync(port, urlPrefix, timeoutMs);
            if (string.IsNullOrEmpty(webSocketUrl))
            {
                throw new TimeoutException("没有找到可调试的页面（端口 " + port + "）");
            }
            _cts = new CancellationTokenSource();
            _socket = new ClientWebSocket();
            _socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(10);
            await _socket.ConnectAsync(new Uri(webSocketUrl), _cts.Token);
            _receiveLoop = Task.Run(new Func<Task>(ReceiveLoop));
            Log.Info("CDP 已连接: " + webSocketUrl);
            return webSocketUrl;
        }

        private async Task<string> FindTargetAsync(int port, string urlPrefix, int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
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
                await Task.Delay(300);
                waited += 300;
            }
            return null;
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
            if (_socket == null || _socket.State != WebSocketState.Open)
            {
                throw new InvalidOperationException("CDP 未连接");
            }
            int id = ++_nextId;
            TaskCompletionSource<Dictionary<string, object>> tcs = new TaskCompletionSource<Dictionary<string, object>>();
            _pending[id] = tcs;

            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            message["method"] = method;
            message["params"] = parameters;
            string json = Json.Stringify(message);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token);

            Task finished = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
            if (finished != tcs.Task)
            {
                _pending.Remove(id);
                throw new TimeoutException("CDP 调用超时: " + method);
            }
            return await tcs.Task;
        }

        private async Task ReceiveLoop()
        {
            byte[] buffer = new byte[16384];
            StringBuilder builder = new StringBuilder();
            try
            {
                while (_socket.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }
                    builder.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    if (!result.EndOfMessage)
                    {
                        continue;
                    }
                    string text = builder.ToString();
                    builder.Length = 0;
                    HandleMessage(text);
                }
            }
            catch (Exception error)
            {
                if (!_cts.IsCancellationRequested)
                {
                    Log.Warn("CDP 接收循环结束: " + error.Message);
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
            TaskCompletionSource<Dictionary<string, object>> tcs;
            if (_pending.TryGetValue(id, out tcs))
            {
                _pending.Remove(id);
                if (message.ContainsKey("error") && !tcs.Task.IsCompleted)
                {
                    Log.Warn("CDP 返回错误: " + Json.Stringify(message["error"]));
                }
                tcs.TrySetResult(message);
            }
        }

        public void Dispose()
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
            try
            {
                if (_socket != null)
                {
                    _socket.Dispose();
                }
            }
            catch
            {
            }
            try
            {
                _http.Dispose();
            }
            catch
            {
            }
            _socket = null;
        }
    }
}
