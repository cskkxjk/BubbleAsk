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
            // 同一个 exe 两种身份：带 --service 就是无界面后台服务（被托盘或插件拉起），
            // 否则是托盘界面。这样部署只有一个文件。
            if (IsServiceMode(args))
            {
                Environment.ExitCode = ServiceProgram.Run();
                return;
            }

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

        /// <summary>命令行里有没有 <see cref="IpcContract.ServiceSwitch"/>。</summary>
        private static bool IsServiceMode(string[] args)
        {
            if (args == null)
            {
                return false;
            }
            for (int index = 0; index < args.Length; index++)
            {
                if (string.Equals(args[index], IpcContract.ServiceSwitch, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }
    }
}
