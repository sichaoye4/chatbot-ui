import { test as base, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
type Runtime = { url: string; token: string; restart: () => Promise<void> };
export const test = base.extend<{ runtime: Runtime }>({
  runtime: async ({}, use, info) => {
    const mode = info.project.name === 'live' ? 'deepseek' : 'deterministic';
    if (mode === 'deepseek' && !process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY_FILE)
      throw new Error('LIVE_GATE_BLOCKED: configure DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE');
    const dir = mkdtempSync(join(tmpdir(), 'csv-browser-'));
    const token = randomUUID();
    let child: ChildProcess | undefined;
    let port = 0;
    let logs = '';
    async function start() {
      child = fork(resolve('dist/server/apps/reference-server/main.js'), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          AGENT_MODE: mode,
          PORT: String(port),
          DATABASE_PATH: join(dir, 'test.sqlite'),
          APP_TEST_TOKEN: token,
        },
      });
      child.stdout?.on('data', (b) => {
        logs += String(b);
      });
      child.stderr?.on('data', (b) => {
        logs += String(b);
      });
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => reject(new Error('Server readiness timeout')), 20000);
        child!.once('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        child!.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Server exited before readiness: ${code}`));
        });
        child!.on('message', (m: unknown) => {
          if ((m as { ready: boolean }).ready) {
            port = (m as { port: number }).port;
            clearTimeout(timeout);
            done();
          }
        });
      });
    }
    async function stop() {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((r) => child!.once('exit', () => r()));
        child.kill();
        await exited;
      }
    }
    try {
      await start();
      await use({
        get url() {
          return `http://127.0.0.1:${port}`;
        },
        token,
        restart: async () => {
          await stop();
          await start();
        },
      });
    } finally {
      await stop();
      await info.attach('server-log', { body: logs, contentType: 'text/plain' });
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
export { expect };
