using System;
using System.Threading;

namespace BubbleAsk
{
    /// <summary>
    /// 无界面后台服务模式。
    ///
    /// 它不是第二个 exe，而是 `BubbleAsk.exe --service`：同一个文件，靠命令行开关
    /// 切到无界面分支（分派见 <c>src/ui/Program.cs</c>）。这样部署只有一个可执行
    /// 文件，不会出现「两个 exe 必须放同一目录」「版本错配」这类问题。
    ///
    /// 生命周期（与客户端约定）：
    ///   - 任意客户端（托盘应用、DSH 插件、将来的 CLI）发现它没在跑就拉起它。
    ///   - 客户端通过 `attach` 持有一条长期连接作为「租约」。
    ///   - 最后一条租约断开后进入宽限期；宽限期内有新租约接入就取消退出。
    ///   - 从未有过租约（例如手工启动）则不会自行退出。
    ///
    /// 刻意**不**做成 Windows 服务（SCM）：Session 0 隔离下无法创建/聚焦用户桌面上的
    /// 浏览器窗口，而本服务的职责正是驱动那个窗口。所以它是每用户的后台进程。
    ///
    /// 单实例：抢不到互斥时**静默退出**，绝不弹框 —— 托盘开机自启与 DSH 启动
    /// 可能同时拉起服务，这属于预期竞争。
    /// </summary>
    internal static class ServiceProgram
    {
        /// <summary>与托盘应用的互斥分开，两者可以同时运行。</summary>
        private const string MutexName = "BubbleAsk.Service.SingleInstance.4C81";

        /// <summary>最后一条租约断开后等这么久再退出，覆盖客户端重启/插件重载。</summary>
        private const int GraceMilliseconds = 8000;

        /// <summary>跑服务模式，返回进程退出码。由界面入口按 `--service` 分派进来。</summary>
        public static int Run()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // 另一个实例已经在服务；静默退出，让调用方去连管道。
                    return 0;
                }

                Log.Init(AppConfig.LogPath);
                Log.Info("==== BubbleAsk 服务启动 ====");

                AppConfig config = AppConfig.Load();
                PipeHost host = null;
                PipeServer server = null;
                ManualResetEvent shutdown = new ManualResetEvent(false);
                Timer graceTimer = null;
                object timerGate = new object();
                bool sawLease = false;

                try
                {
                    host = new PipeHost(config);
                    host.LogBrowser();

                    server = new PipeServer(host);

                    server.LeaseAttached += delegate
                    {
                        lock (timerGate)
                        {
                            sawLease = true;
                            if (graceTimer != null)
                            {
                                graceTimer.Dispose();
                                graceTimer = null;
                                Log.Info("宽限期内有新客户端接入，取消退出");
                            }
                        }
                    };

                    server.LeasesDrained += delegate
                    {
                        lock (timerGate)
                        {
                            if (!sawLease)
                            {
                                return;
                            }
                            if (graceTimer != null)
                            {
                                return;
                            }
                            Log.Info("所有客户端已断开，" + (GraceMilliseconds / 1000) + " 秒后退出");
                            graceTimer = new Timer(delegate
                            {
                                Log.Info("宽限期结束，服务退出");
                                shutdown.Set();
                            }, null, GraceMilliseconds, Timeout.Infinite);
                        }
                    };

                    server.Start();
                    IpcContract.WriteDiscovery(IpcContract.AppExePath);
                    Log.Info("服务就绪，管道: " + IpcContract.PipeName);

                    // 没有 WinForms 消息循环，靠一个事件把主线程挂住。
                    shutdown.WaitOne();
                    return 0;
                }
                catch (Exception error)
                {
                    Log.Error("服务启动失败", error);
                    return 1;
                }
                finally
                {
                    lock (timerGate)
                    {
                        if (graceTimer != null)
                        {
                            graceTimer.Dispose();
                            graceTimer = null;
                        }
                    }
                    if (server != null)
                    {
                        server.Dispose();
                    }
                    if (host != null)
                    {
                        host.Dispose();
                    }
                    shutdown.Dispose();
                    mutex.ReleaseMutex();
                    Log.Info("==== BubbleAsk 服务退出 ====");
                }
            }
        }
    }
}
