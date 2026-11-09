import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const RELEASE_VERIFICATION_LANES = Object.freeze([
  'quality',
  'integration-1',
  'integration-2',
  'e2e-chromium',
  'e2e-firefox',
  'e2e-webkit',
  'docker',
  'native',
  'uid-1000-1000',
  'uid-1001-1001',
  'uid-2000-2001',
]);
export const VERIFICATION_ARTIFACT_NAME = 'verification-evidence';
export const VERIFICATION_EVIDENCE_FILE = 'verification-evidence.json';
export const MAX_VERIFICATION_ZIP_BYTES = 1024 * 1024;
export const MAX_VERIFICATION_JSON_BYTES = 512 * 1024;
const generated = new Set([
  '.git',
  '.foliohaven',
  '.alfred',
  'node_modules',
  'dist',
  '.astro',
  '.vite',
  '.cache',
  '.pnpm-store',
  '.wrangler',
  'coverage',
  'test-results',
  'playwright-report',
  '__pycache__',
]);
const toolchainFiles = [
  '.node-version',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'Dockerfile',
  '.github/actions/prepare-verification/action.yml',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const safePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !isAbsolute(value) &&
  !/[\\\p{Cc}]/u.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const verificationDigest = (value) =>
  hash(JSON.stringify(canonical(value)));
export class VerificationContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VerificationContractError';
    this.code = code;
  }
}
const fail = (code) => {
  throw new VerificationContractError(code);
};

async function readSourceFile(
  root,
  path,
  maximum = 512 * 1024 * 1024,
  collect = true,
) {
  if (!safePath(path)) fail('VERIFICATION_SOURCE_INVALID');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail('VERIFICATION_SOURCE_INVALID');
  }
  const handle = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum))
      fail('VERIFICATION_SOURCE_INVALID');
    let bytes,
      size = 0;
    const fingerprint = createHash('sha256');
    if (collect) {
      bytes = await handle.readFile();
      size = bytes.length;
      fingerprint.update(bytes);
    } else {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > maximum) fail('VERIFICATION_SOURCE_INVALID');
        fingerprint.update(chunk);
      }
    }
    const after = await handle.stat({ bigint: true });
    if (
      size > maximum ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      BigInt(size) !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.mode !== after.mode
    )
      fail('VERIFICATION_SOURCE_CHANGED');
    return {
      bytes,
      entry: {
        path,
        bytes: size,
        mode: Number(after.mode & 0o777n)
          .toString(8)
          .padStart(3, '0'),
        sha256: fingerprint.digest('hex'),
      },
    };
  } finally {
    await handle.close();
  }
}
async function file(root, path) {
  return (await readSourceFile(root, path, 512 * 1024 * 1024, false)).entry;
}
async function sourceJson(root, path) {
  const { bytes } = await readSourceFile(root, path, 8 * 1024 * 1024);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('VERIFICATION_SOURCE_INVALID');
  }
}
const sensitive = (path) =>
  path
    .split('/')
    .some((part) => ['.codex', '.ssh', '.aws', '.agents'].includes(part)) ||
  (!['.env.example', '.env.cloudflare.example'].includes(path) &&
    /(?:^|\/)(?:\.env(?:\..*)?|cloudflare\.config\.json|.*\.(?:pem|key))$/u.test(
      path,
    ));
const ignored = (path) =>
  path.split('/').some((part) => generated.has(part)) ||
  /(?:^|\/).*\.tsbuildinfo$/u.test(path);
async function walk(root, prefix = '', strict = false) {
  const directory = await lstat(join(root, prefix));
  if (!directory.isDirectory() || directory.isSymbolicLink())
    fail('VERIFICATION_SOURCE_INVALID');
  const result = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (ignored(path)) continue;
    if (sensitive(path)) {
      if (strict) fail('VERIFICATION_SOURCE_INVALID');
      continue;
    }
    if (entry.isSymbolicLink()) fail('VERIFICATION_SOURCE_INVALID');
    if (entry.isDirectory()) result.push(...(await walk(root, path, strict)));
    else if (entry.isFile()) result.push(path);
    else fail('VERIFICATION_SOURCE_INVALID');
    if (result.length > 10000) fail('VERIFICATION_SOURCE_INVALID');
  }
  return result;
}

/** Read only declared public source files. Local fallback never includes credentials. */
export async function describeVerificationSource(
  sourceRoot,
  { requirePublicExport = false } = {},
) {
  const root = resolve(sourceRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail('VERIFICATION_SOURCE_INVALID');
  const metadata = await sourceJson(root, 'package.json');
  if (metadata.name !== 'foliohaven' || typeof metadata.version !== 'string')
    fail('VERIFICATION_SOURCE_INVALID');
  let info;
  try {
    info = await sourceJson(root, 'release-info.json');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let paths;
  let sourceMode;
  if (info) {
    if (requirePublicExport) {
      try {
        await lstat(join(root, '.git'));
        fail('VERIFICATION_SOURCE_INVALID');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (
      info.format !== 1 ||
      info.product !== 'foliohaven' ||
      info.version !== metadata.version ||
      !Array.isArray(info.files) ||
      !info.files.length ||
      info.files.length > 10000
    )
      fail('VERIFICATION_SOURCE_INVALID');
    const declared = new Map();
    for (const entry of info.files) {
      if (
        !record(entry) ||
        !safePath(entry.path) ||
        ignored(entry.path) ||
        sensitive(entry.path) ||
        entry.path === 'release-info.json' ||
        declared.has(entry.path) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[0-7]{3}$/u.test(entry.mode ?? '') ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')
      )
        fail('VERIFICATION_SOURCE_INVALID');
      declared.set(entry.path, entry);
    }
    paths = (await walk(root, '', true)).sort();
    if (
      paths.length !== declared.size + 1 ||
      paths.some((path) => path !== 'release-info.json' && !declared.has(path))
    )
      fail('VERIFICATION_SOURCE_CHANGED');
    const files = [];
    for (const path of paths) files.push(await file(root, path));
    for (const item of files) {
      if (item.path === 'release-info.json') continue;
      const expected = declared.get(item.path);
      if (
        item.bytes !== expected.bytes ||
        item.mode !== expected.mode ||
        item.sha256 !== expected.sha256
      )
        fail('VERIFICATION_SOURCE_CHANGED');
    }
    paths = files;
    sourceMode = 'public-export';
  } else {
    if (requirePublicExport) fail('VERIFICATION_SOURCE_INVALID');
    const manifest = await sourceJson(root, 'release/manifest.json');
    const selected = new Set();
    for (const path of manifest.rootFiles) {
      if (!safePath(path)) fail('VERIFICATION_SOURCE_INVALID');
      if (ignored(path) || sensitive(path)) continue;
      try {
        if ((await lstat(join(root, path))).isFile()) selected.add(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    for (const directory of manifest.directories) {
      if (!safePath(directory)) fail('VERIFICATION_SOURCE_INVALID');
      if (ignored(directory) || sensitive(directory)) continue;
      for (const path of await walk(root, directory)) {
        if (
          /(?:^|\/)(?:\.env(?:\..*)?|cloudflare\.config\.json|.*\.(?:pem|key))$/u.test(
            path,
          ) &&
          !['.env.example', '.env.cloudflare.example'].includes(path)
        )
          continue;
        selected.add(path);
      }
    }
    try {
      for (const path of await walk(root, '.github')) selected.add(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    paths = [];
    for (const path of [...selected].sort()) paths.push(await file(root, path));
    sourceMode = 'local';
  }
  const byPath = new Map(paths.map((entry) => [entry.path, entry]));
  const tools = toolchainFiles.map((path) => {
    if (!byPath.has(path) && sourceMode !== 'local')
      fail('VERIFICATION_SOURCE_INVALID');
    return byPath.get(path) ?? { path, absent: true };
  });
  tools.push(
    ...paths.filter((entry) =>
      /^(?:packages\/[^/]+|site|studio|server)\/package\.json$/u.test(
        entry.path,
      ),
    ),
  );
  const contract = {
    schemaVersion: 1,
    lanes: RELEASE_VERIFICATION_LANES,
    files: paths.filter(
      (entry) =>
        entry.path.startsWith('.github/') ||
        /^scripts\/.*(?:verif|check-release|native-release-process).*\.(?:mjs|sh)$/u.test(
          entry.path,
        ),
    ),
  };
  return {
    schemaVersion: 1,
    product: 'foliohaven',
    version: metadata.version,
    sourceMode,
    sourceFingerprint: verificationDigest({
      schemaVersion: 1,
      product: 'foliohaven',
      version: metadata.version,
      sourceMode,
      files: paths,
    }),
    contractDigest: verificationDigest(contract),
    toolchainDigest: verificationDigest(tools),
  };
}

export function validateVerificationLane(
  value,
  descriptor,
  { lane, scope = 'full' } = {},
) {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.lane !== 'string' ||
    (lane !== undefined && value.lane !== lane) ||
    value.scope !== scope ||
    value.status !== 'passed' ||
    ![
      'product',
      'version',
      'sourceMode',
      'sourceFingerprint',
      'contractDigest',
      'toolchainDigest',
    ].every((key) => value[key] === descriptor[key]) ||
    !Array.isArray(value.commands) ||
    !value.commands.length ||
    value.commands.length > 512 ||
    value.commands.some(
      (command) =>
        !record(command) ||
        command.exitCode !== 0 ||
        !Array.isArray(command.argv) ||
        !command.argv.length ||
        command.argv.length > 512 ||
        command.argv.some(
          (arg) =>
            typeof arg !== 'string' || arg.length > 8192 || /\p{Cc}/u.test(arg),
        ),
    )
  )
    fail('VERIFICATION_LANE_INVALID');
  const coverage = value.coverage;
  if (
    !record(coverage) ||
    !/^[a-f0-9]{64}$/u.test(coverage.planDigest ?? '') ||
    !['unitFiles', 'integrationFiles', 'e2eFiles'].every(
      (key) =>
        Array.isArray(coverage[key]) &&
        coverage[key].length <= 10000 &&
        new Set(coverage[key]).size === coverage[key].length &&
        coverage[key].every(safePath),
    ) ||
    ![null, 'chromium', 'firefox', 'webkit'].includes(coverage.browser) ||
    !Array.isArray(coverage.reports) ||
    coverage.reports.some(
      (report) =>
        !record(report) ||
        !['vitest', 'playwright'].includes(report.framework) ||
        !safePath(report.path) ||
        !['total', 'passed', 'failed', 'skipped'].every(
          (key) => Number.isSafeInteger(report[key]) && report[key] >= 0,
        ) ||
        report.failed !== 0 ||
        report.passed + report.skipped !== report.total,
    )
  )
    fail('VERIFICATION_LANE_INVALID');
  for (const [framework, required] of [
    ['vitest', coverage.unitFiles.length + coverage.integrationFiles.length],
    ['playwright', coverage.e2eFiles.length],
  ]) {
    if (
      required &&
      !coverage.reports.some(
        (report) => report.framework === framework && report.passed > 0,
      )
    )
      fail('VERIFICATION_LANE_INVALID');
  }
  return value;
}
export function validateVerificationEvidence(
  value,
  {
    descriptor,
    repository = 'hsunAlfred/foliohaven',
    ref = 'refs/heads/main',
    checkoutSha,
    runId,
    runAttempt,
  },
) {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.scope !== 'full' ||
    value.status !== 'passed' ||
    descriptor.sourceMode !== 'public-export' ||
    value.sourceMode !== 'public-export' ||
    value.product !== descriptor.product ||
    value.version !== descriptor.version ||
    value.sourceFingerprint !== descriptor.sourceFingerprint ||
    value.contractDigest !== descriptor.contractDigest ||
    value.toolchainDigest !== descriptor.toolchainDigest ||
    value.repository !== repository ||
    value.ref !== ref ||
    value.checkoutSha !== checkoutSha ||
    !validId(runId) ||
    !validId(runAttempt) ||
    value.runId !== runId ||
    value.runAttempt !== runAttempt ||
    !Array.isArray(value.lanes) ||
    value.lanes.length !== RELEASE_VERIFICATION_LANES.length
  )
    fail('VERIFICATION_EVIDENCE_INVALID');
  const seen = new Set();
  for (const lane of value.lanes) {
    if (
      seen.has(lane?.lane) ||
      !RELEASE_VERIFICATION_LANES.includes(lane?.lane)
    )
      fail('VERIFICATION_EVIDENCE_INVALID');
    seen.add(lane.lane);
    validateVerificationLane(lane, descriptor);
    if (lane.coverage.planDigest !== value.lanes[0].coverage.planDigest)
      fail('VERIFICATION_EVIDENCE_INVALID');
  }
  return value;
}

/** Bounded ZIP reader: one regular JSON file; ZIP64 is accepted only within our limits. */
export function decodeVerificationArchive(input) {
  const bytes = Buffer.from(input);
  const invalid = () => fail('VERIFICATION_ARCHIVE_INVALID');
  if (bytes.length < 22 || bytes.length > MAX_VERIFICATION_ZIP_BYTES) invalid();
  const number64 = (offset) => {
    if (offset < 0 || offset + 8 > bytes.length) invalid();
    const value = bytes.readBigUInt64LE(offset);
    if (value > BigInt(MAX_VERIFICATION_ZIP_BYTES)) invalid();
    return Number(value);
  };
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    invalid();
  let central = bytes.readUInt32LE(end + 16),
    centralSize = bytes.readUInt32LE(end + 12),
    entries = bytes.readUInt16LE(end + 10),
    centralEnd = end;
  if (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50) {
    if (bytes.readUInt32LE(end - 16) !== 0 || bytes.readUInt32LE(end - 4) !== 1)
      invalid();
    const zip64 = number64(end - 12);
    if (
      zip64 + 56 > end - 20 ||
      bytes.readUInt32LE(zip64) !== 0x06064b50 ||
      number64(zip64 + 4) < 44 ||
      zip64 + 12 + number64(zip64 + 4) !== end - 20 ||
      bytes.readUInt32LE(zip64 + 16) !== 0 ||
      bytes.readUInt32LE(zip64 + 20) !== 0 ||
      number64(zip64 + 24) !== 1 ||
      number64(zip64 + 32) !== 1
    )
      invalid();
    entries = number64(zip64 + 32);
    central = number64(zip64 + 48);
    centralSize = number64(zip64 + 40);
    centralEnd = zip64;
  } else if (bytes.readUInt16LE(end + 8) !== entries) invalid();
  if (
    entries !== 1 ||
    central < 30 ||
    centralSize < 46 ||
    central + centralSize !== centralEnd ||
    central + 46 > bytes.length ||
    bytes.readUInt32LE(central) !== 0x02014b50
  )
    invalid();
  const flags = bytes.readUInt16LE(central + 8),
    method = bytes.readUInt16LE(central + 10),
    crc = bytes.readUInt32LE(central + 16),
    nameLength = bytes.readUInt16LE(central + 28),
    extraLength = bytes.readUInt16LE(central + 30),
    commentLength = bytes.readUInt16LE(central + 32);
  const kind = (bytes.readUInt32LE(central + 38) >>> 16) & 0xf000;
  if (
    (kind !== 0 && kind !== 0x8000) ||
    flags & ~0x0808 ||
    ![0, 8].includes(method) ||
    46 + nameLength + extraLength + commentLength !== centralSize ||
    bytes.readUInt16LE(central + 34) !== 0 ||
    bytes.subarray(central + 46, central + 46 + nameLength).toString('utf8') !==
      VERIFICATION_EVIDENCE_FILE
  )
    invalid();
  let size = bytes.readUInt32LE(central + 24),
    compressed = bytes.readUInt32LE(central + 20),
    local = bytes.readUInt32LE(central + 42);
  const extras = (start, length) => {
    const result = new Map();
    let offset = start;
    while (offset < start + length) {
      if (offset + 4 > start + length) invalid();
      const id = bytes.readUInt16LE(offset),
        size = bytes.readUInt16LE(offset + 2);
      offset += 4;
      if (offset + size > start + length || result.has(id)) invalid();
      result.set(id, { offset, size });
      offset += size;
    }
    return result;
  };
  const centralExtras = extras(central + 46 + nameLength, extraLength);
  if ([size, compressed, local].includes(0xffffffff)) {
    const extended = centralExtras.get(1);
    if (!extended) invalid();
    let offset = extended.offset;
    const take = () => {
      if (offset + 8 > extended.offset + extended.size) invalid();
      const value = number64(offset);
      offset += 8;
      return value;
    };
    if (size === 0xffffffff) size = take();
    if (compressed === 0xffffffff) compressed = take();
    if (local === 0xffffffff) local = take();
  }
  if (
    size < 1 ||
    size > MAX_VERIFICATION_JSON_BYTES ||
    compressed > MAX_VERIFICATION_ZIP_BYTES ||
    local !== 0 ||
    bytes.readUInt32LE(local) !== 0x04034b50 ||
    bytes.readUInt16LE(local + 6) !== flags ||
    bytes.readUInt16LE(local + 8) !== method
  )
    invalid();
  const localNameLength = bytes.readUInt16LE(local + 26),
    localExtraLength = bytes.readUInt16LE(local + 28),
    start = local + 30 + localNameLength + localExtraLength;
  if (
    start + compressed > central ||
    bytes
      .subarray(local + 30, local + 30 + localNameLength)
      .toString('utf8') !== VERIFICATION_EVIDENCE_FILE
  )
    invalid();
  let localCompressed = bytes.readUInt32LE(local + 18),
    localSize = bytes.readUInt32LE(local + 22);
  const localExtras = extras(local + 30 + localNameLength, localExtraLength);
  if (localCompressed === 0xffffffff || localSize === 0xffffffff) {
    const extended = localExtras.get(1);
    if (!extended) invalid();
    let offset = extended.offset;
    if (localSize === 0xffffffff) {
      if (offset + 8 > extended.offset + extended.size) invalid();
      localSize = number64(offset);
      offset += 8;
    }
    if (localCompressed === 0xffffffff) {
      if (offset + 8 > extended.offset + extended.size) invalid();
      localCompressed = number64(offset);
    }
  }
  if (!(flags & 8)) {
    if (
      bytes.readUInt32LE(local + 14) !== crc ||
      localCompressed !== compressed ||
      localSize !== size ||
      start + compressed !== central
    )
      invalid();
  } else {
    let offset = start + compressed;
    if (offset + 4 <= central && bytes.readUInt32LE(offset) === 0x08074b50)
      offset += 4;
    const remaining = central - offset;
    if (![12, 20].includes(remaining) || bytes.readUInt32LE(offset) !== crc)
      invalid();
    const actualCompressed =
      remaining === 20 ? number64(offset + 4) : bytes.readUInt32LE(offset + 4);
    const actualSize =
      remaining === 20 ? number64(offset + 12) : bytes.readUInt32LE(offset + 8);
    if (actualCompressed !== compressed || actualSize !== size) invalid();
  }
  let output;
  try {
    output =
      method === 0
        ? bytes.subarray(start, start + compressed)
        : inflateRawSync(bytes.subarray(start, start + compressed), {
            maxOutputLength: MAX_VERIFICATION_JSON_BYTES,
          });
  } catch {
    invalid();
  }
  let checksum = 0xffffffff;
  for (const byte of output) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++)
      checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
  }
  if (output.length !== size || (checksum ^ 0xffffffff) >>> 0 !== crc)
    invalid();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
  } catch {
    invalid();
  }
}
