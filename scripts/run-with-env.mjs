import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';

const [, , envFile, command, ...args] = process.argv;

if (!envFile || !command) {
  console.error('Usage: node scripts/run-with-env.mjs <env-file> <command> [...args]');
  process.exit(1);
}

if (!existsSync(envFile)) {
  console.error(`Environment file not found: ${envFile}`);
  process.exit(1);
}

const env = {
  ...process.env,
  ...parse(readFileSync(envFile)),
};

const child = spawn(command, args, {
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
