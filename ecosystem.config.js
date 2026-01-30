module.exports = {
  apps: [
    {
      name: 'fi-email-backend',
      script: './backend/server.js',
      instances: 2,
      exec_mode: 'cluster',
      node_args: '--expose-gc --max-old-space-size=1536',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/fi_email/backend-error.log',
      out_file: '/var/log/fi_email/backend-out.log',
      log_file: '/var/log/fi_email/backend-combined.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '1G',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      listen_timeout: 10000,
      kill_timeout: 5000
    },
    {
      name: 'fi-email-worker',
      script: './backend/worker.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--expose-gc --max-old-space-size=1536',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/fi_email/worker-error.log',
      out_file: '/var/log/fi_email/worker-out.log',
      log_file: '/var/log/fi_email/worker-combined.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '1200M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      listen_timeout: 10000,
      kill_timeout: 5000
    },
    {
      name: 'fi-email-frontend',
      script: 'npx',
      args: 'serve -s frontend/dist/frontend/browser -l 4000',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/fi_email/frontend-error.log',
      out_file: '/var/log/fi_email/frontend-out.log',
      log_file: '/var/log/fi_email/frontend-combined.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s'
    }
  ]
};
