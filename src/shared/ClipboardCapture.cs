using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>剪贴板相关：抓取当前选中文字、把图片放进剪贴板、模拟 Ctrl+C / Ctrl+V。</summary>
    public static class ClipboardCapture
    {
        private const byte VkControl = 0x11;
        private const byte VkMenu = 0x12;
        private const byte VkShift = 0x10;
        private const byte VkLWin = 0x5B;
        private const byte VkRWin = 0x5C;
        private const byte VkC = 0x43;
        private const byte VkV = 0x56;
        private const uint KeyEventKeyUp = 0x0002;

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        /// <summary>
        /// 让前台应用把当前选区复制到剪贴板，读出文本后还原原剪贴板内容。
        /// 失败返回 null（例如目标程序不支持复制，或选区是图片）。
        /// </summary>
        public static string TryGetSelectedText(int timeoutMs)
        {
            IDataObject backup = null;
            try
            {
                backup = Clipboard.GetDataObject();
            }
            catch (Exception error)
            {
                Log.Warn("读取原剪贴板失败: " + error.Message);
            }

            try
            {
                ClearClipboardWithRetry();
                SendCopy();
                return WaitForText(timeoutMs);
            }
            finally
            {
                Restore(backup);
            }
        }

        public static void SendCopy()
        {
            // 热键里的 Alt / Shift / Win 可能还按着，先松开，否则会变成别的组合键。
            keybd_event(VkMenu, 0, KeyEventKeyUp, UIntPtr.Zero);
            keybd_event(VkShift, 0, KeyEventKeyUp, UIntPtr.Zero);
            keybd_event(VkLWin, 0, KeyEventKeyUp, UIntPtr.Zero);
            keybd_event(VkRWin, 0, KeyEventKeyUp, UIntPtr.Zero);
            Thread.Sleep(40);

            keybd_event(VkControl, 0, 0, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event(VkC, 0, 0, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event(VkC, 0, KeyEventKeyUp, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event(VkControl, 0, KeyEventKeyUp, UIntPtr.Zero);
        }

        public static void SendPaste()
        {
            keybd_event(VkMenu, 0, KeyEventKeyUp, UIntPtr.Zero);
            keybd_event(VkShift, 0, KeyEventKeyUp, UIntPtr.Zero);
            Thread.Sleep(30);

            keybd_event(VkControl, 0, 0, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event(VkV, 0, 0, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event(VkV, 0, KeyEventKeyUp, UIntPtr.Zero);
            Thread.Sleep(15);
            keybd_event(VkControl, 0, KeyEventKeyUp, UIntPtr.Zero);
        }

        public static bool TrySetImage(string path)
        {
            try
            {
                using (Image image = Image.FromFile(path))
                {
                    Clipboard.SetImage(image);
                }
                return true;
            }
            catch (Exception error)
            {
                Log.Error("写入图片到剪贴板失败", error);
                return false;
            }
        }

        public static bool TrySetText(string text)
        {
            try
            {
                if (string.IsNullOrEmpty(text))
                {
                    Clipboard.Clear();
                }
                else
                {
                    Clipboard.SetText(text);
                }
                return true;
            }
            catch (Exception error)
            {
                Log.Error("写入文本到剪贴板失败", error);
                return false;
            }
        }

        private static void ClearClipboardWithRetry()
        {
            for (int i = 0; i < 3; i++)
            {
                try
                {
                    Clipboard.Clear();
                    return;
                }
                catch
                {
                    Thread.Sleep(40);
                }
            }
        }

        private static string WaitForText(int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                try
                {
                    if (Clipboard.ContainsText())
                    {
                        string text = Clipboard.GetText();
                        if (!string.IsNullOrEmpty(text))
                        {
                            return text;
                        }
                    }
                }
                catch
                {
                }
                Thread.Sleep(25);
                waited += 25;
            }
            return null;
        }

        private static void Restore(IDataObject backup)
        {
            try
            {
                if (backup != null)
                {
                    Clipboard.SetDataObject(backup, true);
                }
                else
                {
                    Clipboard.Clear();
                }
            }
            catch
            {
            }
        }
    }
}
