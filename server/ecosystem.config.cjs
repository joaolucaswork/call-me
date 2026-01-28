const fs = require('fs');
const path = require('path');

// Load .env file
const envPath = path.join(__dirname, '.env');
const envVars = {};

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        envVars[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
}

module.exports = {
  apps: [
    {
      name: 'ngrok',
      script: 'bash',
      args: '-c "pkill -x ngrok 2>/dev/null; sleep 2; exec ngrok http 3333 --domain=helena-call.ngrok.app"',
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
        ...envVars,
      },
    },
  ],
};
