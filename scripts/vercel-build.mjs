import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
    env: process.env,
    ...options,
  });

  if (result.status !== 0) {
    const printable = [command, ...args].join(' ');
    throw new Error(`Command failed: ${printable}`);
  }
};

run('npm', ['install', '--no-save', '--package-lock=false', '--prefix', 'server']);
run('npm', ['install', '--no-save', '--package-lock=false', '--prefix', 'client', '--include=dev']);
run('npm', ['run', 'build', '--prefix', 'client']);

const sourceDir = path.join(repoRoot, 'client', 'dist');
const targetDir = path.join(repoRoot, 'dist');

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Copied ${sourceDir} to ${targetDir}`);
