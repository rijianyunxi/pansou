module.exports = {
  apps: [
    {
      name: "panhub",
      cwd: __dirname,
      script: "./.output/server/index.mjs",
      interpreter: "node",
      node_args: "--env-file=.env.production",

      exec_mode: "fork",
      instances: 1,

      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      max_memory_restart: "1024M",

      kill_timeout: 30000,
      listen_timeout: 10000,

      time: true,
      merge_logs: true,
    },
  ],
};
