module.exports = {
  apps: [
    {
      name: 'ngrok',
      script: 'ngrok',
      args: 'http 3333 --domain=helena-call.ngrok.app',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'callme',
      script: 'src/http-server.ts',
      interpreter: 'bun',
      cwd: '/Users/lucas/Documents/GitHub/call-me/server',
      watch: ['src'],
      ignore_watch: ['node_modules'],
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        CALLME_PUBLIC_URL: 'https://helena-call.ngrok.app',
      },
    },
  ],
};
