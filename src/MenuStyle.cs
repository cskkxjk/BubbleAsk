using System.Drawing;
using System.Windows.Forms;

namespace BubbleAsk
{
    /// <summary>托盘右键菜单的扁平样式：白底、细边、选中是主题蓝。</summary>
    internal class FlatMenuRenderer : ToolStripProfessionalRenderer
    {
        public FlatMenuRenderer()
            : base(new FlatColorTable())
        {
            RoundedEdges = false;
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Selected ? Color.White : Color.FromArgb(31, 41, 55);
            base.OnRenderItemText(e);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            using (Pen pen = new Pen(Color.FromArgb(229, 231, 235)))
            {
                Rectangle bounds = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
                e.Graphics.DrawRectangle(pen, bounds);
            }
        }
    }

    internal class FlatColorTable : ProfessionalColorTable
    {
        private static readonly Color Accent = Color.FromArgb(77, 107, 254);
        private static readonly Color Line = Color.FromArgb(229, 231, 235);
        private static readonly Color Hover = Color.FromArgb(243, 245, 255);

        public override Color ToolStripDropDownBackground
        {
            get { return Color.White; }
        }

        public override Color MenuItemSelected
        {
            get { return Accent; }
        }

        public override Color MenuItemSelectedGradientBegin
        {
            get { return Accent; }
        }

        public override Color MenuItemSelectedGradientEnd
        {
            get { return Accent; }
        }

        public override Color MenuItemBorder
        {
            get { return Accent; }
        }

        public override Color MenuItemPressedGradientBegin
        {
            get { return Hover; }
        }

        public override Color MenuItemPressedGradientEnd
        {
            get { return Hover; }
        }

        public override Color ImageMarginGradientBegin
        {
            get { return Color.White; }
        }

        public override Color ImageMarginGradientMiddle
        {
            get { return Color.White; }
        }

        public override Color ImageMarginGradientEnd
        {
            get { return Color.White; }
        }

        public override Color SeparatorDark
        {
            get { return Line; }
        }

        public override Color SeparatorLight
        {
            get { return Color.White; }
        }
    }
}
