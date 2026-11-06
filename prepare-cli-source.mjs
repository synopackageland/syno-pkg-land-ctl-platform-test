// Download only a public test-repository release asset; no GitHub credentials needed.
import {createHash} from 'node:crypto';
import {mkdtempSync, openSync, writeSync, closeSync, rmSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const prefix = '/synopackageland/syno-pkg-land-ctl-platform-test/releases/download/';
const destinations = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function safeUrl(value, initial = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !destinations.has(url.hostname) ||
    initial && (url.hostname !== 'github.com' || !url.pathname.startsWith(prefix) || !url.pathname.endsWith('.tgz'))) {
    throw new Error('Use an HTTPS .tgz release asset from the public ctl platform test repository');
  }
  return url;
}
export async function prepareCliSource({version, url, fetcher = fetch, temporaryRoot = tmpdir()} = {}) {
  if (!url) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('Provide an exact cli_version or cli_tgz_url');
    return {source:version};
  }
  let current = safeUrl(url, true), response;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetcher(current, {redirect:'manual', signal});
    if (![301,302,303,307,308].includes(response.status)) break;
    await response.body?.cancel();
    current = safeUrl(new URL(response.headers.get('location'), current).href);
    response = undefined;
  }
  if (!response?.ok || !response.body) throw new Error('CLI release asset download failed');
  const maximum = 64 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) { await response.body.cancel(); throw new Error('CLI release asset exceeds 64 MiB'); }
  const folder = mkdtempSync(join(temporaryRoot, 'ctl-source-')), source = join(folder, 'cli.tgz');
  let fd;
  try {
    fd = openSync(source, 'wx', 0o600);
    const hash = createHash('sha256');let size = 0;
    for await (const part of response.body) {
      const chunk = Buffer.from(part);size += chunk.length;
      if (size > maximum) throw new Error('CLI release asset exceeds 64 MiB');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    }
    closeSync(fd);fd = undefined;
    if (!size) throw new Error('Empty CLI release asset');
    return {source, sha256:hash.digest('hex')};
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(folder, {recursive:true, force:true});
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await prepareCliSource({version:process.env.CLI_VERSION, url:process.env.CLI_TGZ_URL, temporaryRoot:process.env.RUNNER_TEMP ?? tmpdir()});
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
  appendFileSync(process.env.GITHUB_ENV, `CLI_SOURCE=${result.source}\n`);
  console.log(result.sha256 ? `[CLI SOURCE] release asset SHA256=${result.sha256}` : `[CLI SOURCE] npm version=${result.source}`);
}
