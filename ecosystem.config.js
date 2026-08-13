// The out_file/error_file entries below are a safety net, not the log. They capture
// crash output and uncaught exceptions that never reach winston, and PM2 does not rotate
// them by date - backend/services/diskCleanupService.js keeps them under a size cap.
//
// The readable, searchable record is written by backend/utils/logger.js to
// /var/log/fi_email/app-YYYY-MM-DD.log (plus debug- and error-), and read back with
// `cd backend && npm run logs -- --runs`. The per-app *-combined.log entries were
// removed: with out_file and error_file already present they were a third copy of every
// line.
module.exports = {
  apps: [
    {
      name: 'fi-email-backend',
      script: './backend/server.js',
      // Two instances for API throughput. Schedulers are registered only on the fork
      // where NODE_APP_INSTANCE === '0' (see backend/utils/clusterRole.js), and every
      // scheduled job additionally takes a Mongo lock (backend/services/jobLock.js) -
      // without both, every cron here fires twice and two processes interleave their
      // writes to the same document-register CSV.
      //
      // Changing this env block needs `pm2 delete fi-email-backend && pm2 start
      // ecosystem.config.js`; `pm2 reload` does not pick up env changes.
      instances: 2,
      exec_mode: 'cluster',
      instance_var: 'NODE_APP_INSTANCE',
      node_args: '--expose-gc --max-old-space-size=1536',
      env: {
        NODE_ENV: 'production',
        SCHEDULERS_ENABLED: 'true'
      },
      error_file: '/var/log/fi_email/backend-error.log',
      out_file: '/var/log/fi_email/backend-out.log',
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
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '1200M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      listen_timeout: 10000,
      kill_timeout: 5000
    },
    {
      name: 'aws-document-ingestion',
      script: './backend/ingestion-worker.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--expose-gc --max-old-space-size=512',
      env: {
        NODE_ENV: 'production',
        INGESTION_RUN_ON_STARTUP: 'false',
        INGESTION_SCHEDULER_ENABLED: 'true',
        INGESTION_CLEANUP_FILTER_DOCS: 'true'
      },
      error_file: '/var/log/fi_email/aws-ingestion-error.log',
      out_file: '/var/log/fi_email/aws-ingestion-out.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '500M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      listen_timeout: 10000,
      kill_timeout: 5000
    },
    {
      name: 'fi-email-frontend',
      script: 'npx',
      args: 'serve -s dist/frontend/browser -l 4000',
      cwd: './frontend',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/fi_email/frontend-error.log',
      out_file: '/var/log/fi_email/frontend-out.log',
      time_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s'
    }
  ]
};
