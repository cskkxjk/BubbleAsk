using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;

namespace BubbleAsk
{
    /// <summary>
    /// 页面驱动的**加载器**（唯一真源是仓库根的 `shared/driver.js`）。
    ///
    /// 编译时以 `/resource` 内嵌进 exe，运行时读出来交给 CDP 注入 —— 所以仍然是单 exe，
    /// 不额外落文件、也不需要生成 C# 代码。
    ///
    /// 同一份 driver.js 也被 Chrome 扩展当 content script 使用（由 tools/gen-providers.mjs
    /// 同步到 chrome-extension/content/driver.js）。合并前这里曾是 399 行「用 C# 拼 JS 字符串」，
    /// 与扩展手写的 390 行并行维护同一批逻辑。
    /// </summary>
    internal static class DriverScript
    {
        /// <summary>内嵌资源名：build.ps1 里用 /resource:...,BubbleAsk.driver.js 指定。</summary>
        internal const string ResourceName = "BubbleAsk.driver.js";

        private static string _source;

        internal static string Source
        {
            get
            {
                if (_source == null)
                {
                    _source = Load();
                }
                return _source;
            }
        }

        private static string Load()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream(ResourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException(
                        "缺少内嵌资源 " + ResourceName + "（build.ps1 的 /resource 参数漏了 shared/driver.js？）");
                }
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string text = reader.ReadToEnd();
                    if (text.IndexOf("__bubbleAskDriver", StringComparison.Ordinal) < 0)
                    {
                        throw new InvalidOperationException("driver.js 内容不对：没有 __bubbleAskDriver 导出");
                    }
                    return text;
                }
            }
        }
    }
}
