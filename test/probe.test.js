// -----------------------------------------------------------------------------
// scripts/probe.mjs against fake devices served on 127.0.0.1: it reads,
// lists, listens, writes nothing, and prints no secret.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { FakeAxis, PASSWORD } from './helpers/fakeAxis.js';

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/probe.mjs', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env, LOG_LEVEL: 'silent' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('the probe reads a camera and its events, writes nothing, prints no secret', async (t) => {
  const fake = new FakeAxis({ name: 'camera' });
  const server = await fake.serve();
  t.after(() => server.close());
  const emitting = setInterval(() => fake.emit('personStart'), 300);
  t.after(() => clearInterval(emitting));
  const { code, output } = await run([server.origin, 'root', '1'], { AXIS_PASSWORD: PASSWORD });
  assert.equal(code, 0, output);
  assert.match(output, /Model\s+AXIS P3268-LVE \(Dome Camera\)/);
  assert.match(output, /Serial\s+…2B3C/);
  assert.match(output, /Port 0\s+input "Garden gate"/);
  assert.match(output, /AOA scenarios\s+1 "Driveway" \[human\]/);
  assert.match(output, /Event stream open \(websocket\)/);
  assert.match(output, /ObjectAnalytics\/Device1Scenario1 Changed/);
  for (const secret of [PASSWORD, 'ACCC8E1A2B3C']) {
    assert.ok(!output.includes(secret), secret);
  }
  assert.deepEqual(fake.outputCommands, []);
  assert.deepEqual(fake.lightCommands, []);
  assert.deepEqual(fake.clipsPlayed, []);
});

test('the probe stops at a refused password, and says how to use it', async () => {
  const fake = new FakeAxis({ name: 'camera' });
  const server = await fake.serve();
  const refused = await run([server.origin], { AXIS_PASSWORD: 'wrong' });
  await server.close();
  assert.equal(refused.code, 1);
  assert.match(refused.output, /password refused/);
  assert.equal(fake.refusals, 1);
  const usage = await run([], { AXIS_PASSWORD: '' });
  assert.equal(usage.code, 2);
});
