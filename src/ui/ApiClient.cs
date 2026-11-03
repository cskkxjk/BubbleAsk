using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>一条对话消息。图片只挂在 user 消息上。</summary>
    public class ApiMessage
    {
        public string Role;
        public string Text;
        public List<string> ImagePaths = new List<string>();

        public ApiMessage(string role, string text)
        {
            Role = role;
            Text = text ?? "";
        }
    }

    /// <summary>一次请求的全部参数。</summary>
    public class ApiRequest
    {
        public string BaseUrl = "https://api.deepseek.com";
        public string ApiKey = "";
        public string Model = "deepseek-chat";
        public string SystemPrompt = "";
        public int MaxTokens = 2048;
        public List<ApiMessage> Messages = new List<ApiMessage>();
    }

    public class ApiException : Exception
    {
        public int Status;

        public ApiException(int status, string message)
            : base(message)
        {
            Status = status;
        }
    }

    /// <summary>OpenAI 兼容的 /chat/completions 客户端，只做流式和一次性两种读法。</summary>
    public static class ApiClient
    {
        /// <summary>非流式兜底最多缓存这么多字符，再多就会把 JSON 切坏、没法可靠解析。</summary>
        private const int RawCacheLimit = 400000;

        /// <summary>默认超时：5 分钟。HttpClient 自带的 100 秒对长回答不够用。</summary>
        public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(5);

        // 静态字段按声明顺序初始化：DefaultTimeout 必须排在 _http 前面。
        private static TimeSpan _timeout = DefaultTimeout;
        private static HttpClient _http = CreateHttp(_timeout);

        /// <summary>当前的请求超时。超时和用户主动取消在界面上要分开处理，所以公开出来给提示文案用。</summary>
        public static TimeSpan RequestTimeout
        {
            get { return _timeout; }
        }

        /// <summary>超时的可读写法，给"请求超时（5 分钟未响应）"这类提示用。</summary>
        public static string TimeoutText
        {
            get
            {
                TimeSpan value = _timeout;
                if (value <= TimeSpan.Zero)
                {
                    value = DefaultTimeout;
                }
                if (value.TotalSeconds < 60)
                {
                    int seconds = (int)Math.Round(value.TotalSeconds);
                    return (seconds > 0 ? seconds : 1) + " 秒";
                }
                int minutes = (int)Math.Round(value.TotalMinutes);
                return (minutes > 0 ? minutes : 1) + " 分钟";
            }
        }

        /// <summary>
        /// 改请求超时。只给自测用：HttpClient.Timeout 一旦发过请求就改不了，
        /// 所以这里换掉底层客户端——必须在第一次请求之前调用，之后请求重新用默认值也不要紧。
        /// </summary>
        public static void ConfigureTimeout(TimeSpan timeout)
        {
            _timeout = timeout > TimeSpan.Zero ? timeout : DefaultTimeout;
            HttpClient old = _http;
            _http = CreateHttp(_timeout);
            if (old != null)
            {
                try
                {
                    old.Dispose();
                }
                catch
                {
                }
            }
        }

        private static HttpClient CreateHttp(TimeSpan timeout)
        {
            HttpClient client = new HttpClient();
            client.Timeout = timeout;
            return client;
        }

        /// <summary>把用户填的 base 补成完整的 chat/completions 地址。</summary>
        public static string ResolveEndpoint(string baseUrl)
        {
            string url = (baseUrl ?? string.Empty).Trim();
            if (url.Length == 0)
            {
                url = "https://api.deepseek.com";
            }
            url = url.TrimEnd('/');
            if (url.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase))
            {
                return url;
            }
            if (url.EndsWith("/v1", StringComparison.OrdinalIgnoreCase))
            {
                return url + "/chat/completions";
            }
            return url + "/v1/chat/completions";
        }

        /// <summary>拼请求体。抽出来是为了能在自测里直接比对 JSON。</summary>
        public static string BuildBody(ApiRequest request)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["model"] = request.Model;
            body["stream"] = true;
            if (request.MaxTokens > 0)
            {
                body["max_tokens"] = request.MaxTokens;
            }

            List<object> messages = new List<object>();
            if (!string.IsNullOrEmpty(request.SystemPrompt))
            {
                messages.Add(TextMessage("system", request.SystemPrompt));
            }
            for (int i = 0; i < request.Messages.Count; i++)
            {
                ApiMessage item = request.Messages[i];
                if (item == null)
                {
                    continue;
                }
                if (item.ImagePaths != null && item.ImagePaths.Count > 0)
                {
                    messages.Add(ImageMessage(item));
                }
                else
                {
                    messages.Add(TextMessage(item.Role, item.Text));
                }
            }
            body["messages"] = messages;
            return Json.Stringify(body);
        }

        private static Dictionary<string, object> TextMessage(string role, string text)
        {
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["role"] = role;
            message["content"] = text ?? string.Empty;
            return message;
        }

        private static Dictionary<string, object> ImageMessage(ApiMessage item)
        {
            List<object> parts = new List<object>();
            string text = item.Text ?? string.Empty;
            if (text.Length > 0)
            {
                Dictionary<string, object> textPart = new Dictionary<string, object>();
                textPart["type"] = "text";
                textPart["text"] = text;
                parts.Add(textPart);
            }
            for (int i = 0; i < item.ImagePaths.Count; i++)
            {
                Dictionary<string, object> imagePart = new Dictionary<string, object>();
                imagePart["type"] = "image_url";
                Dictionary<string, object> url = new Dictionary<string, object>();
                url["url"] = EncodeImage(item.ImagePaths[i], 1400);
                imagePart["image_url"] = url;
                parts.Add(imagePart);
            }
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["role"] = item.Role;
            message["content"] = parts;
            return message;
        }

        /// <summary>读图片并转成 data URL；超过 maxDimension 的先等比缩小，省 token 也省时间。</summary>
        public static string EncodeImage(string path, int maxDimension)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                throw new FileNotFoundException("图片不存在: " + path);
            }
            using (Image image = Image.FromFile(path))
            {
                int limit = maxDimension > 0 ? maxDimension : 1400;
                int width = image.Width;
                int height = image.Height;
                double scale = 1.0;
                if (width > limit || height > limit)
                {
                    scale = Math.Min((double)limit / width, (double)limit / height);
                }
                int targetWidth = Math.Max(1, (int)Math.Round(width * scale));
                int targetHeight = Math.Max(1, (int)Math.Round(height * scale));

                using (Bitmap target = new Bitmap(targetWidth, targetHeight))
                {
                    using (Graphics graphics = Graphics.FromImage(target))
                    {
                        graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        graphics.DrawImage(image, 0, 0, targetWidth, targetHeight);
                    }
                    using (MemoryStream buffer = new MemoryStream())
                    {
                        target.Save(buffer, ImageFormat.Png);
                        return "data:image/png;base64," + Convert.ToBase64String(buffer.ToArray());
                    }
                }
            }
        }

        /// <summary>老的四参版本：不需要通知回调的调用方（含自测）继续用它。</summary>
        public static Task<string> StreamAsync(ApiRequest request, Action<string> onContent,
            Action<string> onReasoning, CancellationToken token)
        {
            return StreamAsync(request, onContent, onReasoning, null, token);
        }

        /// <summary>
        /// 流式请求；每来一小段就回调一次，返回值是拼好的全文。
        /// onNotice 用来报告"不致命但用户该知道"的事（例如被 max_tokens 截断），可以是 null。
        /// </summary>
        public static async Task<string> StreamAsync(ApiRequest request, Action<string> onContent,
            Action<string> onReasoning, Action<string> onNotice, CancellationToken token)
        {
            string endpoint = ResolveEndpoint(request.BaseUrl);
            HttpRequestMessage message = new HttpRequestMessage(HttpMethod.Post, endpoint);
            if (!string.IsNullOrEmpty(request.ApiKey))
            {
                message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", request.ApiKey.Trim());
            }
            message.Content = new StringContent(BuildBody(request), Encoding.UTF8, "application/json");

            HttpResponseMessage response;
            try
            {
                response = await _http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, token);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new ApiException(0, "连不上 " + endpoint + "：" + error.Message);
            }

            if (!response.IsSuccessStatusCode)
            {
                int status = (int)response.StatusCode;
                string errorBody = "";
                try
                {
                    errorBody = await response.Content.ReadAsStringAsync();
                }
                catch
                {
                }
                response.Dispose();
                throw new ApiException(status, DescribeHttpError(status, errorBody));
            }

            StringBuilder all = new StringBuilder();
            StringBuilder raw = new StringBuilder();
            bool sawData = false;
            bool rawTruncated = false;
            bool hitMaxTokens = false;
            bool contentFiltered = false;

            using (response)
            {
                try
                {
                    using (Stream stream = await response.Content.ReadAsStreamAsync())
                    {
                        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                        {
                            // 关键：.NET Framework 的 HttpClient.Timeout 只覆盖到"响应头到达"，
                            // 头到了之后正文再卡住是没有超时的（ReadLineAsync 也不接受 token）。
                            // 所以这里自己给每一行加看门狗，否则气泡会永远停在流式态。
                            int idleBudgetMs = (int)Math.Max(1000, _timeout.TotalMilliseconds);
                            while (!token.IsCancellationRequested)
                            {
                                Task<string> readTask = reader.ReadLineAsync();
                                Task watchdog = Task.Delay(idleBudgetMs, token);
                                Task first = await Task.WhenAny(readTask, watchdog);
                                if (first != readTask)
                                {
                                    // 看门狗先到：要么用户取消，要么服务器不发正文了。
                                    if (token.IsCancellationRequested)
                                    {
                                        ObserveQuietly(readTask);
                                        break;
                                    }
                                    ObserveQuietly(readTask);
                                    throw new ApiException(0,
                                        "读取响应超时（" + TimeoutText + "没有收到新内容）：服务器接了请求但一直不发正文，" +
                                        "检查接口地址或换个时间重试。");
                                }
                                string line = await readTask;
                                if (line == null)
                                {
                                    break;
                                }
                                if (raw.Length < RawCacheLimit)
                                {
                                    raw.AppendLine(line);
                                }
                                else
                                {
                                    rawTruncated = true;
                                }
                                string trimmed = line.Trim();
                                if (trimmed.Length == 0)
                                {
                                    continue;
                                }
                                if (!trimmed.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                                {
                                    continue;
                                }
                                sawData = true;
                                string payload = trimmed.Substring(5).Trim();
                                if (payload.Length == 0)
                                {
                                    continue;
                                }
                                if (payload == "[DONE]")
                                {
                                    break;
                                }
                                string content;
                                string reasoning;
                                string finishReason;
                                string streamError;
                                bool hasDelta = TryParseChunk(payload, out content, out reasoning,
                                    out finishReason, out streamError);
                                if (streamError != null)
                                {
                                    // 上下文超长、内容过滤这类问题，服务端会在流里塞一帧 error，不能再当没看见。
                                    throw new ApiException(0, streamError);
                                }
                                if (finishReason.Length > 0)
                                {
                                    if (string.Equals(finishReason, "length", StringComparison.OrdinalIgnoreCase))
                                    {
                                        hitMaxTokens = true;
                                    }
                                    else if (string.Equals(finishReason, "content_filter", StringComparison.OrdinalIgnoreCase))
                                    {
                                        contentFiltered = true;
                                    }
                                }
                                if (!hasDelta)
                                {
                                    continue;
                                }
                                if (!string.IsNullOrEmpty(reasoning) && onReasoning != null)
                                {
                                    onReasoning(reasoning);
                                }
                                if (!string.IsNullOrEmpty(content))
                                {
                                    all.Append(content);
                                    if (onContent != null)
                                    {
                                        onContent(content);
                                    }
                                }
                            }
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (ApiException)
                {
                    throw;
                }
                catch (IOException error)
                {
                    // 读到一半连接断了：给用户人话，别把裸异常名丢出来。
                    throw new ApiException(0, "读取响应时连接中断：" + error.Message);
                }
                catch (System.Net.WebException error)
                {
                    throw new ApiException(0, "读取响应时连接中断：" + error.Message);
                }
                catch (HttpRequestException error)
                {
                    throw new ApiException(0, "读取响应时连接中断：" + error.Message);
                }
            }

            token.ThrowIfCancellationRequested();

            if (!sawData)
            {
                // 有些服务方忽略 stream，直接回一整块 JSON。
                string rawText = raw.ToString();
                if (rawTruncated)
                {
                    // 再往下解析只会把残缺的 JSON 当成空回答，不如直接说清楚。
                    throw new ApiException(0, "服务端没有按流式返回，内容又超过 " + RawCacheLimit
                        + " 字符，已被截断、无法解析。请改用支持 stream 的接口地址。");
                }
                string rawError = ExtractStreamError(rawText);
                if (rawError != null)
                {
                    throw new ApiException(0, rawError);
                }
                string full = ExtractFullContent(rawText);
                if (full.Length > 0)
                {
                    all.Append(full);
                    if (onContent != null)
                    {
                        onContent(full);
                    }
                }
            }

            string result = all.ToString();
            if (result.Length == 0)
            {
                // 空回答不能当成功返回：气泡里一个字都没有，用户会以为卡住了。
                if (hitMaxTokens)
                {
                    throw new ApiException(0, "模型返回了空内容：max_tokens（" + request.MaxTokens
                        + "）太小，一个字都没生成出来，可在设置里调大。");
                }
                throw new ApiException(0, "模型返回了空内容（HTTP 200，但响应里没有正文）。");
            }
            if (hitMaxTokens && onNotice != null)
            {
                onNotice("（回答被 max_tokens 截断）");
            }
            else if (contentFiltered && onNotice != null)
            {
                onNotice("（回答被内容过滤中断）");
            }
            return result;
        }

        /// <summary>吞掉被抛弃任务的异常，避免"未观察异常"把进程弄崩。</summary>
        private static void ObserveQuietly(Task task)
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

        /// <summary>解析一条 SSE 的 data 负载，取出增量正文与推理内容。</summary>
        public static bool TryParseDelta(string data, out string content, out string reasoning)
        {
            string finishReason;
            string streamError;
            return TryParseChunk(data, out content, out reasoning, out finishReason, out streamError);
        }

        /// <summary>
        /// 解析一条 SSE 负载：增量正文、推理内容、choice 级的 finish_reason，以及流里的 error 帧。
        /// 只有 finish_reason 的收尾帧返回 false（但 finishReason 已经填好）。
        /// </summary>
        private static bool TryParseChunk(string data, out string content, out string reasoning,
            out string finishReason, out string streamError)
        {
            content = "";
            reasoning = "";
            finishReason = "";
            streamError = null;
            if (string.IsNullOrEmpty(data))
            {
                return false;
            }
            Dictionary<string, object> root = Json.ParseObject(data);
            if (root.Count == 0)
            {
                return false;
            }
            streamError = DescribeErrorObject(root);
            if (streamError != null)
            {
                return false;
            }
            List<object> choices = GetList(root, "choices");
            if (choices.Count == 0)
            {
                return false;
            }
            Dictionary<string, object> choice = choices[0] as Dictionary<string, object>;
            if (choice == null)
            {
                return false;
            }
            finishReason = Json.GetString(choice, "finish_reason", "");
            Dictionary<string, object> delta = GetDict(choice, "delta");
            if (delta == null)
            {
                return false;
            }
            content = Json.GetString(delta, "content", "");
            reasoning = Json.GetString(delta, "reasoning_content", Json.GetString(delta, "reasoning", ""));
            return true;
        }

        /// <summary>
        /// 从一段 JSON 里取 error 对象的说明（message + code）；没有 error 返回 null。
        /// 流里的 data: {"error":{...}} 帧和一次性返回的错误体都走这里。
        /// </summary>
        public static string ExtractStreamError(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return null;
            }
            Dictionary<string, object> root = Json.ParseObject(json);
            if (root.Count == 0)
            {
                return null;
            }
            return DescribeErrorObject(root);
        }

        private static string DescribeErrorObject(Dictionary<string, object> root)
        {
            object value;
            if (root == null || !root.TryGetValue("error", out value) || value == null)
            {
                return null;
            }
            // 有些网关会回 {"error": false}，那不是错误。
            if (value is bool)
            {
                return null;
            }
            string message = "";
            string code = "";
            Dictionary<string, object> detail = value as Dictionary<string, object>;
            if (detail != null)
            {
                message = Json.GetString(detail, "message", "");
                code = Json.GetString(detail, "code", "");
                if (code.Length == 0)
                {
                    code = Json.GetString(detail, "type", "");
                }
                if (code.Length == 0)
                {
                    code = Json.GetString(detail, "status", "");
                }
            }
            else
            {
                message = Convert.ToString(value);
            }
            message = (message ?? "").Trim();
            if (message.Length == 0)
            {
                message = "服务端返回了错误，但没给原因";
            }
            if (message.Length > 200)
            {
                message = message.Substring(0, 200) + "…";
            }
            if (code.Length > 0)
            {
                return "服务端返回错误：" + message + "（" + code + "）";
            }
            return "服务端返回错误：" + message;
        }

        /// <summary>非流式响应里取正文。</summary>
        public static string ExtractFullContent(string json)
        {
            Dictionary<string, object> root = Json.ParseObject(json);
            if (root.Count == 0)
            {
                return "";
            }
            List<object> choices = GetList(root, "choices");
            if (choices.Count == 0)
            {
                return "";
            }
            Dictionary<string, object> choice = choices[0] as Dictionary<string, object>;
            if (choice == null)
            {
                return "";
            }
            Dictionary<string, object> message = GetDict(choice, "message");
            if (message == null)
            {
                message = GetDict(choice, "delta");
            }
            return message == null ? "" : Json.GetString(message, "content", "");
        }

        private static Dictionary<string, object> GetDict(Dictionary<string, object> data, string key)
        {
            object value;
            if (data == null || !data.TryGetValue(key, out value))
            {
                return null;
            }
            return value as Dictionary<string, object>;
        }

        private static List<object> GetList(Dictionary<string, object> data, string key)
        {
            object value;
            if (data == null || !data.TryGetValue(key, out value) || value == null)
            {
                return new List<object>();
            }
            object[] array = value as object[];
            if (array != null)
            {
                return new List<object>(array);
            }
            System.Collections.ArrayList list = value as System.Collections.ArrayList;
            if (list != null)
            {
                return new List<object>(list.ToArray());
            }
            return new List<object>();
        }

        /// <summary>把状态码翻译成人话，省得用户看 401 猜半天。</summary>
        public static string DescribeHttpError(int status, string body)
        {
            string hint;
            if (status == 400)
            {
                hint = "请求参数不对（最常见：模型名写错、上下文太长、图片太大或格式不支持）";
            }
            else if (status == 401)
            {
                hint = "API Key 无效或没有被授权";
            }
            else if (status == 402)
            {
                hint = "账户余额/额度不足";
            }
            else if (status == 403)
            {
                hint = "没有权限访问这个接口或模型（检查 Key 的权限、可用模型或所在地区）";
            }
            else if (status == 404)
            {
                hint = "地址或模型名不对（检查接口地址与模型名）";
            }
            else if (status == 413)
            {
                hint = "请求体太大（图片太大、图片太多或对话太长）";
            }
            else if (status == 422)
            {
                hint = "参数无法处理（检查模型名、图片格式与消息结构）";
            }
            else if (status == 429)
            {
                hint = "请求太频繁，稍后再试";
            }
            else if (status >= 500)
            {
                hint = "服务方自己出错了，稍后再试";
            }
            else
            {
                hint = "请求被拒绝";
            }
            string detail = (body ?? string.Empty).Replace("\r", " ").Replace("\n", " ").Trim();
            if (detail.Length > 300)
            {
                detail = detail.Substring(0, 300) + "…";
            }
            return hint + " (HTTP " + status + ")" + (detail.Length > 0 ? "\n" + detail : "");
        }
    }
}
