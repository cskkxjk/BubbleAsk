using System;
using System.Threading;
using System.Windows.Forms;

namespace BubbleAsk
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool createdNew;
            using (Mutex mutex = new Mutex(true, "BubbleAsk.SingleInstance.9F3A", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("Bubble Ask 已经在运行，请查看右下角托盘。", "Bubble Ask",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Log.Init(AppConfig.LogPath);
                AppConfig config = AppConfig.Load();
                Log.Info("==== BubbleAsk 启动 ====");
                ScreenCapture.CleanupOld(1);
                AutoStart.Sync(config);

                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
                {
                    Log.Error("界面线程异常", e.Exception);
                    MessageBox.Show(e.Exception.Message, "Bubble Ask 出错", MessageBoxButtons.OK, MessageBoxIcon.Error);
                };
                AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
                {
                    Log.Error("未处理异常", e.ExceptionObject as Exception);
                };

                using (TrayContext context = new TrayContext(config))
                {
                    Application.Run(context);
                }
            }
        }
    }
}
