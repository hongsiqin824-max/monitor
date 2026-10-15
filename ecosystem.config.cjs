// PM2 守护进程配置 —— 跨平台（macOS 测试 / Linux 生产通用）
// 用法：
//   npm i -g pm2                     # 安装 pm2（一次）
//   pm2 start ecosystem.config.cjs   # 启动并守护
//   pm2 logs match-timeline          # 看实时日志
//   pm2 status                       # 看运行状态
//   pm2 restart match-timeline       # 重启
//   pm2 stop match-timeline          # 停止
//   pm2 save && pm2 startup          # 配置开机自启（按提示执行输出的命令）
module.exports = {
  apps: [
    {
      name: "match-timeline",
      script: "match_timeline.mjs",
      interpreter: "node",
      cwd: __dirname,
      instances: 1,
      autorestart: true,          // 进程崩溃自动拉起（与脚本内 WS 重连互补：双层保活）
      max_restarts: 50,
      restart_delay: 3000,        // 崩溃后 3s 再拉起
      max_memory_restart: "300M", // 内存超限自动重启，防泄漏
      kill_timeout: 5000,         // 给 SIGTERM 优雅退出的时间
      time: true,                 // 日志加时间戳
      merge_logs: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Shanghai",
      },
    },
  ],
};
