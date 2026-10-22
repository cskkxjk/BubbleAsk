using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>全局热键。用一个隐藏窗口接收 WM_HOTKEY。</summary>
    public class HotkeyManager : IDisposable
    {
        private const int WmHotkey = 0x0312;
        private const uint ModAlt = 0x0001;
        private const uint ModControl = 0x0002;
        private const uint ModShift = 0x0004;
        private const uint ModWin = 0x0008;
        private const uint ModNoRepeat = 0x4000;

        private readonly HiddenWindow _window;
        private readonly Dictionary<int, string> _registered = new Dictionary<int, string>();
        private int _nextId = 1;
        private bool _disposed;

        public event Action<string> Pressed;

        public HotkeyManager()
        {
            _window = new HiddenWindow();
            _window.MessageHook = OnHotkeyMessage;
        }

        /// <summary>注册一个形如 "Ctrl+Alt+D" 的热键。返回是否成功。</summary>
        public bool Register(string spec, string name)
        {
            uint modifiers;
            uint key;
            if (!TryParse(spec, out modifiers, out key))
            {
                Log.Warn("热键格式无法解析: " + spec);
                return false;
            }
            int id = _nextId++;
            if (!NativeMethods.RegisterHotKey(_window.Handle, id, modifiers | ModNoRepeat, key))
            {
                Log.Warn("热键被占用或注册失败: " + spec + " (id=" + id + ")");
                return false;
            }
            _registered[id] = name;
            Log.Info("热键已注册: " + spec + " -> " + name);
            return true;
        }

        private void OnHotkeyMessage(int id)
        {
            string name;
            if (_registered.TryGetValue(id, out name) && Pressed != null)
            {
                Pressed(name);
            }
        }

        public static bool TryParse(string spec, out uint modifiers, out uint key)
        {
            modifiers = 0;
            key = 0;
            if (string.IsNullOrEmpty(spec))
            {
                return false;
            }
            string[] parts = spec.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                return false;
            }
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i].Trim();
                if (part.Length == 0)
                {
                    continue;
                }
                string upper = part.ToUpperInvariant();
                if (i < parts.Length - 1)
                {
                    if (upper == "CTRL" || upper == "CONTROL")
                    {
                        modifiers |= ModControl;
                    }
                    else if (upper == "ALT")
                    {
                        modifiers |= ModAlt;
                    }
                    else if (upper == "SHIFT")
                    {
                        modifiers |= ModShift;
                    }
                    else if (upper == "WIN" || upper == "WINDOWS")
                    {
                        modifiers |= ModWin;
                    }
                    else
                    {
                        return false;
                    }
                }
                else
                {
                    if (upper == "CTRL" || upper == "CONTROL" || upper == "ALT" || upper == "SHIFT" ||
                        upper == "WIN" || upper == "WINDOWS")
                    {
                        // 只有修饰键、没有主键
                        return false;
                    }
                    Keys parsed;
                    if (!Enum.TryParse<Keys>(part, true, out parsed))
                    {
                        if (part.Length == 1)
                        {
                            parsed = (Keys)char.ToUpperInvariant(part[0]);
                        }
                        else
                        {
                            return false;
                        }
                    }
                    key = (uint)parsed;
                }
            }
            return key != 0;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            foreach (int id in _registered.Keys)
            {
                NativeMethods.UnregisterHotKey(_window.Handle, id);
            }
            _registered.Clear();
            _window.Dispose();
        }

        private class HiddenWindow : Form
        {
            public Action<int> MessageHook;

            public HiddenWindow()
            {
                ShowInTaskbar = false;
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.Manual;
                Location = new System.Drawing.Point(-4000, -4000);
                Size = new System.Drawing.Size(1, 1);
                // 只创建句柄，不显示窗口。
                IntPtr unused = Handle;
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WmHotkey && MessageHook != null)
                {
                    MessageHook(m.WParam.ToInt32());
                }
                base.WndProc(ref m);
            }
        }

        private static class NativeMethods
        {
            [DllImport("user32.dll", SetLastError = true)]
            public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

            [DllImport("user32.dll", SetLastError = true)]
            public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        }
    }
}
