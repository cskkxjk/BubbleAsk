using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace BubbleAsk
{
    /// <summary>
    /// API 模式的会话：管一个气泡窗口 + 一串对话消息，支持多轮追问。
    /// 公开方法只在界面线程上调用；流式回调内部自己 Post 回界面线程。
    /// </summary>
    public class ApiChat : IDisposable
    {
        private readonly AppConfig _config;
        private AnswerBubble _bubble;
        private List<ApiMessage> _history = new List<ApiMessage>();
        private CancellationTokenSource _cts;
        private int _generation;

        /// <summary>提交给模型的历史消息上限。超出后丢弃最早的问答对，只保留第一条问题。</summary>
        private const int MaxHistoryMessages = 21;

        public ApiChat(AppConfig config)
        {
            _config = config;
        }

        /// <summary>当前气泡窗口，供托盘菜单和自测用；还没提问时为 null。</summary>
        public AnswerBubble Bubble
        {
            get { return _bubble; }
        }

        /// <summary>新问题：开一段新对话。imagePath 可为 null。</summary>
        public void Ask(string prompt, string imagePath)
        {
            // 先把上一轮正在跑的流停掉，免得它的增量混进新问题里。
            CancelCurrent();

            AnswerBubble bubble = EnsureBubble();
            bubble.SetTitle(HeaderText());
            bubble.ShowForAsk();
            bubble.BeginTurn(Describe(prompt, imagePath));

            string problem = Validate();
            if (problem != null)
            {
                Log.Warn("API 模式无法提问: " + problem);
                _history = new List<ApiMessage>();
                bubble.FailTurn(problem);
                return;
            }

            _history = new List<ApiMessage>();
            ApiMessage user = new ApiMessage("user", prompt ?? "");
            if (!string.IsNullOrEmpty(imagePath))
            {
                user.ImagePaths.Add(imagePath);
            }
            _history.Add(user);
            StartStream();
        }

        /// <summary>API 模式下「唤起窗口」：不提问，只把气泡打开等用户输入。</summary>
        public void OpenBlank()
        {
            AnswerBubble bubble = EnsureBubble();
            bubble.SetTitle(HeaderText());
            bubble.ShowForAsk();
            bubble.FocusInput();
        }

        /// <summary>再按一次唤起键：在前台就收起，否则拉到前台。返回 true 表示这次收起了。</summary>
        public bool ToggleBubble()
        {
            AnswerBubble bubble = _bubble;
            if (bubble != null && !bubble.IsDisposed && bubble.Visible)
            {
                if (bubble.IsForegroundWindow)
                {
                    Log.Info("气泡已在前台，收起");
                    bubble.Close();
                    return true;
                }
                bubble.ShowForAsk();
                bubble.FocusInput();
                return false;
            }
            OpenBlank();
            return false;
        }

        public void Dispose()
        {
            CancelCurrent();
            if (_bubble != null && !_bubble.IsDisposed)
            {
                _bubble.Dismissed -= OnBubbleClosed;
                _bubble.Close();
            }
            _bubble = null;
        }

        private AnswerBubble EnsureBubble()
        {
            if (_bubble != null && !_bubble.IsDisposed)
            {
                return _bubble;
            }
            _bubble = new AnswerBubble(_config);
            _bubble.Dismissed += OnBubbleClosed;
            _bubble.FollowUp += OnFollowUp;
            return _bubble;
        }

        private void OnBubbleClosed()
        {
            CancelCurrent();
            _history = new List<ApiMessage>();
        }

        private void OnFollowUp(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return;
            }
            if (_history.Count == 0)
            {
                Ask(text, null);
                return;
            }
            _history.Add(new ApiMessage("user", text));
            EnsureBubble().BeginTurn(text);
            StartStream();
        }

        private void StartStream()
        {
            AnswerBubble bubble = EnsureBubble();
            CancelCurrent();
            int generation = ++_generation;
            CancellationTokenSource cts = new CancellationTokenSource();
            _cts = cts;

            ApiRequest request = new ApiRequest();
            request.BaseUrl = _config.ApiBaseUrl;
            request.ApiKey = _config.ApiKey;
            request.Model = _config.ApiModel;
            request.SystemPrompt = _config.ApiSystemPrompt;
            request.MaxTokens = _config.ApiMaxTokens;
            TrimHistory();
            request.Messages = new List<ApiMessage>(_history);

            CancellationToken token = cts.Token;
            Task.Run(new Func<Task>(async delegate
            {
                // 已经流到气泡里的正文；失败时要用它补历史，所以在这一层攒。
                StringBuilder partial = new StringBuilder();
                try
                {
                    string full = await ApiClient.StreamAsync(request,
                        delegate(string delta)
                        {
                            partial.Append(delta);
                            PostAppend(delta, false, generation);
                        },
                        delegate(string reasoning) { PostAppend(reasoning, true, generation); },
                        delegate(string notice) { PostNotice(notice, generation); },
                        token);

                    bubble.Post(delegate
                    {
                        if (!IsCurrent(generation))
                        {
                            return;
                        }
                        if (full.Length > 0)
                        {
                            _history.Add(new ApiMessage("assistant", full));
                        }
                        bubble.EndTurn();
                        Log.Info("API 回答完成，长度 " + full.Length);
                    });
                }
                catch (OperationCanceledException error)
                {
                    if (token.IsCancellationRequested)
                    {
                        // 用户主动取消：保持静默，但气泡必须退出流式态。
                        Log.Info("API 请求已取消");
                        PostCancel(bubble, generation, partial.ToString());
                    }
                    else
                    {
                        // 没人取消却抛了 OperationCanceledException —— 这是 HttpClient.Timeout 的超时。
                        Log.Error("API 请求超时: " + error.Message);
                        PostFail(bubble, generation,
                            "请求超时（" + ApiClient.TimeoutText + " 未响应）：网络较慢，或中转服务没有返回内容；稍后重试，或检查接口地址。",
                            partial.ToString());
                    }
                }
                catch (ApiException error)
                {
                    Log.Error("API 请求失败: " + error.Message);
                    PostFail(bubble, generation, error.Message, partial.ToString());
                }
                catch (Exception error)
                {
                    Log.Error("API 请求异常", error);
                    PostFail(bubble, generation, "请求出错：" + error.Message, partial.ToString());
                }
            }));
        }

        private void PostAppend(string delta, bool reasoning, int generation)
        {
            AnswerBubble bubble = _bubble;
            if (bubble == null)
            {
                return;
            }
            bubble.Post(delegate
            {
                if (!IsCurrent(generation) || bubble.IsDisposed)
                {
                    return;
                }
                if (reasoning)
                {
                    bubble.AppendReasoning(delta);
                }
                else
                {
                    bubble.AppendAnswer(delta);
                }
            });
        }

        /// <summary>灰字提示（例如被 max_tokens 截断）：用气泡已有的 Note，不动正文。</summary>
        private void PostNotice(string notice, int generation)
        {
            if (string.IsNullOrEmpty(notice))
            {
                return;
            }
            AnswerBubble bubble = _bubble;
            if (bubble == null)
            {
                return;
            }
            bubble.Post(delegate
            {
                if (!IsCurrent(generation) || bubble.IsDisposed)
                {
                    return;
                }
                // 提示单独占一行，避免与刚流出来的正文连在一起。
                bubble.AppendAnswer("\n");
                bubble.Note(notice);
            });
        }

        /// <summary>用户主动取消：不报错，但确保气泡不再停在流式态。</summary>
        private void PostCancel(AnswerBubble bubble, int generation, string partial)
        {
            bubble.Post(delegate
            {
                if (!IsCurrent(generation) || bubble.IsDisposed)
                {
                    return;
                }
                RememberPartial(partial);
                if (bubble.IsStreaming)
                {
                    bubble.EndTurn();
                }
            });
        }

        private void PostFail(AnswerBubble bubble, int generation, string message, string partial)
        {
            bubble.Post(delegate
            {
                if (!IsCurrent(generation))
                {
                    return;
                }
                // 半截答案已经显示在气泡里，历史里也要保留：否则下一轮追问会出现两条连续的 user 消息，
                // 模型看不到用户实际读到的那段。
                RememberPartial(partial);
                if (!string.IsNullOrEmpty(partial))
                {
                    // 另起一行，避免与半截正文连在一起。
                    bubble.AppendAnswer("\n");
                }
                bubble.FailTurn(message);
            });
        }

        /// <summary>把已经显示出来的半截回答补进历史（只补非空的）。</summary>
        private void RememberPartial(string partial)
        {
            if (!string.IsNullOrEmpty(partial))
            {
                _history.Add(new ApiMessage("assistant", partial));
            }
        }

        private bool IsCurrent(int generation)
        {
            return generation == _generation;
        }

        /// <summary>历史只保留最近若干条：长对话继续追问时请求体不会无限增长。</summary>
        private void TrimHistory()
        {
            if (_history.Count <= MaxHistoryMessages)
            {
                return;
            }
            int drop = _history.Count - MaxHistoryMessages;
            List<ApiMessage> kept = new List<ApiMessage>();
            kept.Add(_history[0]);
            for (int i = 1 + drop; i < _history.Count; i += 1)
            {
                kept.Add(_history[i]);
            }
            Log.Info("历史消息过多，丢弃最早的 " + drop + " 条，保留 " + kept.Count + " 条");
            _history = kept;
        }

        private void CancelCurrent()
        {
            _generation++;
            if (_cts != null)
            {
                try
                {
                    _cts.Cancel();
                    _cts.Dispose();
                }
                catch
                {
                }
                _cts = null;
            }
        }

        /// <summary>返回 null 表示可以发；否则是给用户看的提示。</summary>
        private string Validate()
        {
            ApiProvider provider = ApiProviders.Resolve(_config.ApiProvider);
            if (string.IsNullOrEmpty(_config.ApiBaseUrl) && string.IsNullOrEmpty(provider.BaseUrl))
            {
                return "还没填接口地址。托盘菜单 → 设置 → API 里填一个 OpenAI 兼容的地址。";
            }
            if (provider.NeedsKey && string.IsNullOrEmpty(_config.ApiKey))
            {
                return "还没填 API Key。托盘菜单 → 设置 → API 里填一个，只保存在本机。";
            }
            if (string.IsNullOrEmpty(_config.ApiModel))
            {
                return "还没填模型名。设置 → API → 模型，例如 deepseek-chat。";
            }
            return null;
        }

        private string HeaderText()
        {
            ApiProvider provider = ApiProviders.Resolve(_config.ApiProvider);
            string model = string.IsNullOrEmpty(_config.ApiModel) ? provider.Model : _config.ApiModel;
            return provider.Name + " · " + model;
        }

        private static string Describe(string prompt, string imagePath)
        {
            string text = string.IsNullOrEmpty(prompt) ? "" : prompt;
            if (text.Length > 120)
            {
                text = text.Substring(0, 120) + "…";
            }
            if (!string.IsNullOrEmpty(imagePath))
            {
                text = "[截图] " + text;
            }
            return text;
        }
    }
}
