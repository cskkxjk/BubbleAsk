using System;
using System.Drawing;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>
    /// 抓词提问前的那一句「你想问什么」。
    ///
    /// 以前按热键就按模板（默认「什么是%s」）直接发出去，用户没有插话的余地；
    /// 现在先弹这个小框：
    ///   - 写了问题 → 问题 + 选中的文字一起发（PromptBuilder.BuildWithQuestion）；
    ///   - 直接回车（留空）→ 走老模板，一键提问的人不吃亏；
    ///   - Esc / 取消 → 什么都不发。
    ///
    /// 刻意用系统原生控件而不是自绘：这是个只停留一两秒的输入框，可靠比好看重要。
    /// </summary>
    internal sealed class QuestionForm : Form
    {
        private static readonly Color Ink = Color.FromArgb(31, 41, 55);
        private static readonly Color Dim = Color.FromArgb(107, 114, 128);
        private static readonly Color Accent = Color.FromArgb(77, 107, 254);

        private readonly TextBox _input;
        private string _question;

        internal QuestionForm(string selected, string template)
        {
            string skeleton = ShortTemplate(template);

            Text = "Bubble Ask · 抓词提问";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            MinimizeBox = false;
            MaximizeBox = false;
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9F);
            ClientSize = new Size(440, 156);

            Label quote = new Label();
            quote.AutoSize = false;
            quote.Bounds = new Rectangle(14, 12, 412, 34);
            quote.ForeColor = Dim;
            quote.AutoEllipsis = true;
            quote.Text = selected ?? string.Empty;
            Controls.Add(quote);

            Label prompt = new Label();
            prompt.AutoSize = false;
            prompt.Bounds = new Rectangle(14, 50, 412, 18);
            prompt.ForeColor = Ink;
            prompt.Text = "你想问什么？";
            Controls.Add(prompt);

            _input = new TextBox();
            _input.Bounds = new Rectangle(14, 72, 412, 26);
            _input.BorderStyle = BorderStyle.FixedSingle;
            _input.ForeColor = Ink;
            Controls.Add(_input);

            Label hint = new Label();
            hint.AutoSize = false;
            hint.Bounds = new Rectangle(14, 104, 412, 18);
            hint.ForeColor = Dim;
            hint.Text = "回车发送 · Esc 取消 · 留空就按模板「" + skeleton + "」提问";
            Controls.Add(hint);

            Button send = new Button();
            send.Text = "发送";
            send.Bounds = new Rectangle(354, 126, 72, 26);
            send.FlatStyle = FlatStyle.Flat;
            send.FlatAppearance.BorderSize = 0;
            send.BackColor = Accent;
            send.ForeColor = Color.White;
            send.Click += OnSend;
            Controls.Add(send);
            AcceptButton = send;

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Bounds = new Rectangle(274, 126, 72, 26);
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.DialogResult = DialogResult.Cancel;
            Controls.Add(cancel);
            CancelButton = cancel;

            Point cursor = Cursor.Position;
            Rectangle work = Screen.FromPoint(cursor).WorkingArea;
            int left = Math.Min(Math.Max(work.Left + 8, cursor.X - ClientSize.Width / 2), work.Right - Width - 8);
            int top = Math.Min(Math.Max(work.Top + 8, cursor.Y + 20), work.Bottom - Height - 8);
            Location = new Point(left, top);
        }

        /// <summary>提示里只放模板骨架，太长的模板会把这一行撑爆。</summary>
        private static string ShortTemplate(string template)
        {
            string value = string.IsNullOrEmpty(template) ? PromptBuilder.DefaultTemplate : template.Trim();
            return value.Length <= 16 ? value : value.Substring(0, 15) + "…";
        }

        private void OnSend(object sender, EventArgs e)
        {
            _question = (_input.Text ?? string.Empty).Trim();
            DialogResult = DialogResult.OK;
            Close();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Activate();
            _input.Focus();
        }

        /// <summary>
        /// 弹出输入框。
        /// </summary>
        /// <param name="selected">已经规整过的选中文字，只给用户瞄一眼。</param>
        /// <param name="template">留空时用的模板，仅用于提示文案。</param>
        /// <returns>null = 取消；空串 = 用默认模板；否则是用户写的问题。</returns>
        internal static string Ask(string selected, string template)
        {
            using (QuestionForm form = new QuestionForm(selected, template))
            {
                form.ShowDialog();
                if (form.DialogResult != DialogResult.OK)
                {
                    return null;
                }
                return form._question ?? string.Empty;
            }
        }
    }
}
