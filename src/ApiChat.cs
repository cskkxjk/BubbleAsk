using System;
using System.Collections.Generic;
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
            request.Messages = new List<ApiMessage>(_history);

            CancellationToken token = cts.Token;
            Task.Run(new Func<Task>(async delegate
            {
                try
                {
                    string full = await ApiClient.StreamAsync(request,
                        delegate(string delta) { PostAppend(delta, false, generation); },
                        delegate(string reasoning) { PostAppend(reasoning, true, generation); },
                        token);

                    bubble.Post(delegate
                    {
                        if (!IsCurrent(generation))
                        {
                            return;
                        }
                        _history.Add(new ApiMessage("assistant", full));
                        bubble.EndTurn();
                        Log.Info("API 回答完成，长度 " + full.Length);
                    });
                }
                catch (OperationCanceledException)
                {
                    Log.Info("API 请求已取消");
                }
                catch (ApiException error)
                {
                    Log.Error("API 请求失败: " + error.Message);
                    PostFail(bubble, generation, error.Message);
                }
                catch (Exception error)
                {
                    Log.Error("API 请求异常", error);
                    PostFail(bubble, generation, "请求出错：" + error.Message);
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

        private void PostFail(AnswerBubble bubble, int generation, string message)
        {
            bubble.Post(delegate
            {
                if (IsCurrent(generation))
                {
                    bubble.FailTurn(message);
                }
            });
        }

        private bool IsCurrent(int generation)
        {
            return generation == _generation;
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
