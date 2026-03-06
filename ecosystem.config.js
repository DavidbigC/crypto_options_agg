module.exports = {
  apps: [
    {
      name: 'options-backend',
      cwd: './backend',
      script: 'server.js',
      node_args: '--experimental-vm-modules',
      env: { NODE_ENV: 'production', PORT: 8000 },
      restart_delay: 3000,
    },
    {
      name: 'options-frontend',
      cwd: './frontend',
      script: 'node_modules/.bin/next',
      args: 'start -p 3000',
      env: { NODE_ENV: 'production' },
      restart_delay: 3000,
    },
  ],
}
