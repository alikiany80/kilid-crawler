#!/usr/bin/env node
const { main } = require('../src/cli');

main().then(
  code => { process.exitCode = code; },
  err => {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', component: 'cli', msg: 'unexpected error', error: err.message, stack: err.stack }) + '\n');
    process.exitCode = 1;
  }
);
