import { createApplication } from './server.ts';
const mode = process.env.AGENT_MODE ?? 'deterministic';
if (mode !== 'deterministic' && mode !== 'deepseek')
  throw new Error('AGENT_MODE must be deterministic or deepseek');
const app = createApplication({
  database: process.env.DATABASE_PATH,
  mode,
  testToken: process.env.APP_TEST_TOKEN,
});
const port = Number(process.env.PORT ?? 4317);
app.server.listen(port, '127.0.0.1', () => {
  const actual = (app.server.address() as { port: number }).port;
  console.log(`CSV chat ready at http://127.0.0.1:${actual} (${mode}; local demo identity)`);
  process.send?.({ ready: true, port: actual });
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
