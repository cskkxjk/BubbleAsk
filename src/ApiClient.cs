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
        private static readonly HttpClient Http = CreateHttp();

        private static HttpClient CreateHttp()
        {
            HttpClient client = new HttpClient();
            client.Timeout = TimeSpan.FromMinutes(5);
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

        /// <summary>流式请求；每来一小段就回调一次，返回值是拼好的全文。</summary>
        public static async Task<string> StreamAsync(ApiRequest request, Action<string> onContent,
            Action<string> onReasoning, CancellationToken token)
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
                response = await Http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, token);
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

            using (response)
            {
                using (Stream stream = await response.Content.ReadAsStreamAsync())
                {
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        while (!token.IsCancellationRequested)
                        {
                            string line = await reader.ReadLineAsync();
                            if (line == null)
                            {
                                break;
                            }
                            if (raw.Length < 400000)
                            {
                                raw.AppendLine(line);
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
                            if (!TryParseDelta(payload, out content, out reasoning))
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

            token.ThrowIfCancellationRequested();

            if (!sawData)
            {
                // 有些服务方忽略 stream，直接回一整块 JSON。
                string full = ExtractFullContent(raw.ToString());
                if (full.Length > 0)
                {
                    all.Append(full);
                    if (onContent != null)
                    {
                        onContent(full);
                    }
                }
            }
            return all.ToString();
        }

        /// <summary>解析一条 SSE 的 data 负载，取出增量正文与推理内容。</summary>
        public static bool TryParseDelta(string data, out string content, out string reasoning)
        {
            content = "";
            reasoning = "";
            if (string.IsNullOrEmpty(data))
            {
                return false;
            }
            Dictionary<string, object> root = Json.ParseObject(data);
            if (root.Count == 0)
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
            Dictionary<string, object> delta = GetDict(choice, "delta");
            if (delta == null)
            {
                return false;
            }
            content = Json.GetString(delta, "content", "");
            reasoning = Json.GetString(delta, "reasoning_content", Json.GetString(delta, "reasoning", ""));
            return true;
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
            if (status == 401)
            {
                hint = "API Key 无效或没有被授权";
            }
            else if (status == 402)
            {
                hint = "账户余额/额度不足";
            }
            else if (status == 404)
            {
                hint = "地址或模型名不对（检查接口地址与模型名）";
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
