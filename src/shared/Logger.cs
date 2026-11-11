using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace BubbleAsk
{
    /// <summary>极简日志：写文件 + 内存环形缓冲，供设置页排查问题。</summary>
    public static class Log
    {
        private static readonly object Gate = new object();
        private static readonly Queue<string> Recent = new Queue<string>();
        private static string _path;

        public static string FilePath
        {
            get
            {
                lock (Gate)
                {
                    return _path;
                }
            }
        }

        public static void Init(string path)
        {
            lock (Gate)
            {
                _path = path;
                try
                {
                    string dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }
                }
                catch
                {
                }
            }
        }

        public static void Info(string message)
        {
            Write("INFO", message);
        }

        public static void Warn(string message)
        {
            Write("WARN", message);
        }

        public static void Error(string message)
        {
            Write("ERROR", message);
        }

        public static void Error(string message, Exception error)
        {
            Write("ERROR", message + " :: " + (error == null ? "" : error.ToString()));
        }

        private static void Write(string level, string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + message;
            lock (Gate)
            {
                Recent.Enqueue(line);
                while (Recent.Count > 200)
                {
                    Recent.Dequeue();
                }
                if (string.IsNullOrEmpty(_path))
                {
                    return;
                }
                try
                {
                    FileInfo info = new FileInfo(_path);
                    if (info.Exists && info.Length > 1024 * 1024)
                    {
                        File.Delete(_path);
                    }
                    File.AppendAllText(_path, line + Environment.NewLine, Encoding.UTF8);
                }
                catch
                {
                }
            }
        }
    }
}
