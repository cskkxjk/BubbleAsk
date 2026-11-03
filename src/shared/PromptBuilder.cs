using System;
using System.Text;

namespace BubbleAsk
{
    /// <summary>把选中文字套进提问模板。纯函数，便于单测。</summary>
    public static class PromptBuilder
    {
        public const string DefaultTemplate = "什么是%s";
        public const string DefaultShotPrompt = "这张截图里是什么？请解释一下。";

        /// <summary>折叠空白、去首尾、按上限截断。超长时保留头尾，避免只剩半句。</summary>
        public static string Normalize(string raw, int maxChars)
        {
            if (raw == null)
            {
                return string.Empty;
            }
            StringBuilder sb = new StringBuilder(raw.Length);
            bool lastWasSpace = false;
            for (int i = 0; i < raw.Length; i++)
            {
                char c = raw[i];
                bool isSpace = char.IsWhiteSpace(c);
                if (isSpace)
                {
                    if (!lastWasSpace && sb.Length > 0)
                    {
                        sb.Append(' ');
                    }
                    lastWasSpace = true;
                }
                else
                {
                    sb.Append(c);
                    lastWasSpace = false;
                }
            }
            string text = sb.ToString().Trim();
            int limit = maxChars > 0 ? maxChars : 2000;
            if (text.Length <= limit)
            {
                return text;
            }
            int head = limit * 2 / 3;
            int tail = limit - head - 5;
            if (tail < 20)
            {
                return text.Substring(0, limit);
            }
            return text.Substring(0, head) + " … " + text.Substring(text.Length - tail);
        }

        public static string Build(string template, string text)
        {
            string clean = (text ?? string.Empty).Trim();
            if (clean.Length == 0)
            {
                return string.Empty;
            }
            string tpl = string.IsNullOrEmpty(template) ? DefaultTemplate : template;
            if (tpl.Contains("%s"))
            {
                return tpl.Replace("%s", clean);
            }
            return tpl + clean;
        }

        /// <summary>不依赖选中文字的模板（截图提问）：有 %s 就抹掉，没有就原样用。</summary>
        public static string BuildFree(string template)
        {
            string tpl = template ?? string.Empty;
            if (tpl.Contains("%s"))
            {
                tpl = tpl.Replace("%s", string.Empty);
            }
            tpl = tpl.Trim();
            return tpl.Length == 0 ? DefaultShotPrompt : tpl;
        }
    }
}
