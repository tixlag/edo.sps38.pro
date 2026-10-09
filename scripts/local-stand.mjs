import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, '.cache/local-stand');
const stateFile = join(cache, 'processes.json');
const require = createRequire(join(root, 'apps/api/package.json'));
require('dotenv').config({ path: join(root, '.env'), quiet: true });
const apiPort = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || apiPort === 5174) {
  throw new Error('Invalid local API_PORT');
}
mkdirSync(cache, { recursive: true, mode: 0o700 });

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });
}
function readState() {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
}
function startedAt(pid) {
  try {
    // Linux /proc starttime prevents signaling an unrelated process after PID reuse.
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  } catch { return null; }
}
function alive(entry) {
  return Boolean(entry && startedAt(entry.pid) === entry.startedAt);
}
function listening(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
function start(state, name, args, env = {}) {
  if (alive(state[name])) return;
  const log = openSync(join(cache, `${name}.log`), 'a', 0o600);
  const child = spawn('pnpm', args, {
    cwd: root, env: { ...process.env, ...env }, detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.unref();
  state[name] = { pid: child.pid, startedAt: startedAt(child.pid) };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function bucket() {
  const endpoint = new URL(process.env.S3_ENDPOINT ?? 'http://127.0.0.1:5000');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    console.log('External S3: bucket provisioning left to its operator');
    return;
  }
  const { S3Client, HeadBucketCommand, CreateBucketCommand, PutPublicAccessBlockCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: endpoint.href, region: process.env.S3_REGION ?? 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? '', secretAccessKey: process.env.S3_SECRET_KEY ?? '' },
  });
  const Bucket = process.env.S3_BUCKET ?? 'edo-documents';
  try {
    try { await client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(10_000) }); }
    catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
      const region = process.env.S3_REGION ?? 'us-east-1';
      await client.send(new CreateBucketCommand({ Bucket, ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region } }) }), { abortSignal: AbortSignal.timeout(10_000) });
    }
    await client.send(new PutPublicAccessBlockCommand({ Bucket, PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
    } }), { abortSignal: AbortSignal.timeout(10_000) });
    await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [{
      AllowedOrigins: [process.env.CORS_ORIGIN ?? 'https://edo.localhost:12443'],
      AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['Range'],
      ExposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'], MaxAgeSeconds: 300,
    }] } }), { abortSignal: AbortSignal.timeout(10_000) });
    console.log('Local S3 bucket ready');
  } finally { client.destroy(); }
}

async function up() {
  if ((process.env.NODE_ENV ?? 'development') !== 'development') throw new Error('local:up requires NODE_ENV=development');
  const inspection = JSON.parse(run('docker', ['inspect', 'lk_nginx']))[0];
  if (!inspection.State.Running) throw new Error('Start the existing LK stack first');
  const gateway = Object.values(inspection.NetworkSettings.Networks).find(network => network.Gateway)?.Gateway;
  if (!gateway || !/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) throw new Error('LK nginx host gateway not found');
  const state = readState();
  for (const [name, port] of [['api', apiPort], ['web', 5174]]) {
    if (!alive(state[name]) && await listening(port)) throw new Error(`Port ${port} is occupied by another process; nothing stopped`);
  }
  run('docker', ['compose', 'up', '-d', 's3'], { stdio: 'inherit' });
  await bucket();
  const cert = join(cache, 'edo.localhost.pem');
  const key = join(cache, 'edo.localhost-key.pem');
  if (!existsSync(cert) || !existsSync(key)) run('mkcert', ['-cert-file', cert, '-key-file', key, 'edo.localhost', 'localhost', '127.0.0.1', '::1'], { stdio: 'inherit' });
  run('docker', ['cp', cert, 'lk_nginx:/etc/nginx/edo.localhost.pem']);
  run('docker', ['cp', key, 'lk_nginx:/etc/nginx/edo.localhost-key.pem']);
  const rendered = readFileSync(join(root, 'ops/local/edo.nginx.conf.template'), 'utf8')
    .replaceAll('__HOST_GATEWAY__', gateway).replaceAll('__API_PORT__', String(apiPort));
  const config = join(cache, 'edo.nginx.conf');
  writeFileSync(config, rendered);
  const target = '/etc/nginx/conf.d/edo.localhost.conf';
  const previous = run('docker', ['exec', 'lk_nginx', 'sh', '-c', `if [ -f ${target} ]; then cat ${target}; fi`]);
  const lkTarget = '/etc/nginx/conf.d/local.nginx.next.sps38.pro.conf';
  const previousLk = run('docker', ['exec', 'lk_nginx', 'cat', lkTarget]);
  const withoutPatch = previousLk.replace(/^[ \t]*# BEGIN EDO LOCAL REFRESH CORS[\s\S]*?# END EDO LOCAL REFRESH CORS\n?/m, '');
  const authLocation = /^[ \t]*location\s+\^~\s+\/api\/auth\/v1\s*\{/m;
  if (!authLocation.test(withoutPatch)) throw new Error('Existing LK auth proxy location not found; configuration preserved');
  const fragment = readFileSync(join(root, 'ops/local/lk-refresh-cors.nginx.fragment'), 'utf8');
  const lkConfig = join(cache, 'lk.nginx.conf');
  writeFileSync(lkConfig, withoutPatch.replace(authLocation, match => fragment + '\n' + match));
  run('docker', ['cp', config, 'lk_nginx:/etc/nginx/conf.d/edo.localhost.conf']);
  run('docker', ['cp', lkConfig, `lk_nginx:${lkTarget}`]);
  try { run('docker', ['exec', 'lk_nginx', 'nginx', '-t'], { stdio: 'inherit' }); }
  catch (error) {
    const lkBackup = join(cache, 'lk.nginx.previous.conf');
    writeFileSync(lkBackup, previousLk);
    run('docker', ['cp', lkBackup, `lk_nginx:${lkTarget}`]);
    if (previous) {
      const backup = join(cache, 'edo.nginx.previous.conf');
      writeFileSync(backup, previous);
      run('docker', ['cp', backup, `lk_nginx:${target}`]);
    } else run('docker', ['exec', 'lk_nginx', 'rm', '-f', target]);
    throw error;
  }
  run('docker', ['exec', 'lk_nginx', 'nginx', '-s', 'reload'], { stdio: 'inherit' });
  start(state, 'api', ['--filter', '@edo/api', 'dev']);
  start(state, 'web', ['--filter', '@edo/web', 'exec', 'vite', '--host', '0.0.0.0', '--port', '5174', '--strictPort'], {
    EDO_LOCAL_HTTPS: 'true', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-http-header-size=131072`.trim(),
  });
  for (let attempt = 0; attempt < 45; attempt++) {
    if (await listening(apiPort) && await listening(5174)) {
      console.log('EDO: https://edo.localhost:12443\nAPI docs: https://edo.localhost:12443/api/docs\nLogs: .cache/local-stand/{api,web}.log');
      return;
    }
    if (!alive(state.api) || !alive(state.web)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('EDO did not start; inspect .cache/local-stand/{api,web}.log');
}

const command = process.argv[2] ?? 'status';
if (command === 'up') await up();
else if (command === 'down') {
  for (const entry of Object.values(readState())) if (alive(entry)) {
    try { process.kill(-entry.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  rmSync(stateFile, { force: true });
  console.log('EDO processes stopped. Shared LK services and S3 preserved.');
} else if (command === 'status') {
  const state = readState();
  console.log(`API: ${alive(state.api) ? 'running' : 'stopped'}; web: ${alive(state.web) ? 'running' : 'stopped'}\nhttps://edo.localhost:12443`);
} else throw new Error('Usage: pnpm local:up | local:down | local:status');
