using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace BubbleAsk
{
    /// <summary>对 JavaScriptSerializer 的薄封装，统一处理缺失字段与类型转换。</summary>
    public static class Json
    {
        private static readonly JavaScriptSerializer Serializer = CreateSerializer();

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            // 截图走 data URL，base64 很容易超过默认 2MB 上限。
            serializer.MaxJsonLength = 64 * 1024 * 1024;
            serializer.RecursionLimit = 200;
            return serializer;
        }

        public static Dictionary<string, object> ParseObject(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return new Dictionary<string, object>();
            }
            try
            {
                object parsed = Serializer.DeserializeObject(json);
                Dictionary<string, object> dict = parsed as Dictionary<string, object>;
                return dict ?? new Dictionary<string, object>();
            }
            catch
            {
                return new Dictionary<string, object>();
            }
        }

        public static string Stringify(object value)
        {
            return Serializer.Serialize(value);
        }

        public static List<object> ParseArray(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return new List<object>();
            }
            try
            {
                object parsed = Serializer.DeserializeObject(json);
                object[] array = parsed as object[];
                if (array == null)
                {
                    return new List<object>();
                }
                return new List<object>(array);
            }
            catch
            {
                return new List<object>();
            }
        }

        public static string GetString(Dictionary<string, object> data, string key, string fallback)
        {
            object value;
            if (data == null || !data.TryGetValue(key, out value) || value == null)
            {
                return fallback;
            }
            string text = Convert.ToString(value);
            return text ?? fallback;
        }

        public static bool GetBool(Dictionary<string, object> data, string key, bool fallback)
        {
            object value;
            if (data == null || !data.TryGetValue(key, out value) || value == null)
            {
                return fallback;
            }
            try
            {
                return Convert.ToBoolean(value);
            }
            catch
            {
                return fallback;
            }
        }

        public static int GetInt(Dictionary<string, object> data, string key, int fallback)
        {
            object value;
            if (data == null || !data.TryGetValue(key, out value) || value == null)
            {
                return fallback;
            }
            try
            {
                return Convert.ToInt32(value);
            }
            catch
            {
                return fallback;
            }
        }
    }
}
