import { readFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { posix } from 'node:path';

const GIB = 1024 ** 3;
export const MEMORY_RESERVE_BYTES = 512 * 1024 ** 2;
const HEAVY_BYTES = 4 * GIB;
const UNIT_BYTES = 2 * GIB;
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) =>
  typeof value === 'string' &&
  /^\d+$/u.test(value) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0;

export function effectiveVerificationResources({
  availableCpus,
  hostMemoryBytes,
  constrainedMemoryBytes = 0,
  cpuMax,
  cpuQuota,
  cpuPeriod,
}) {
  if (
    !Number.isFinite(availableCpus) ||
    availableCpus <= 0 ||
    !Number.isFinite(hostMemoryBytes) ||
    hostMemoryBytes <= 0
  )
    fail('VERIFY_RESOURCE_INVALID', '無法確認可用的 CPU／記憶體。');
  let quota;
  const maximum = typeof cpuMax === 'string' ? cpuMax.trim().split(/\s+/u) : [];
  if (maximum.length === 2 && positive(maximum[0]) && positive(maximum[1]))
    quota = Number(maximum[0]) / Number(maximum[1]);
  else if (positive(cpuQuota?.trim()) && positive(cpuPeriod?.trim()))
    quota = Number(cpuQuota.trim()) / Number(cpuPeriod.trim());
  return {
    cpus: quota ? Math.min(availableCpus, quota) : availableCpus,
    memoryBytes:
      constrainedMemoryBytes > 0 && Number.isFinite(constrainedMemoryBytes)
        ? Math.min(hostMemoryBytes, constrainedMemoryBytes)
        : hostMemoryBytes,
  };
}
export function parseMemAvailable(value) {
  const match =
    typeof value === 'string' &&
    /^MemAvailable:\s+(\d+)\s+kB\s*$/mu.exec(value);
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  return nonnegative(bytes) ? bytes : null;
}
const absolute = (path) =>
  typeof path === 'string' &&
  path.startsWith('/') &&
  !/[\p{Cc}]/u.test(path) &&
  !path.split('/').some((part) => part === '..' || part === '.');
const unescapeMount = (value) =>
  value.replace(/\\(040|011|012|134)/gu, (_, code) =>
    String.fromCharCode(Number.parseInt(code, 8)),
  );
/** Resolve only this process's cgroup in its real mount, never assume mount root is ours. */
export function cgroupMemoryDirectories(membership, mountinfo) {
  if (typeof membership !== 'string' || typeof mountinfo !== 'string')
    return null;
  const groups = membership
    .split('\n')
    .map((line) => {
      const parts = line.split(':');
      return parts.length === 3
        ? { controllers: parts[1], path: parts[2] }
        : null;
    })
    .filter(Boolean);
  const matches = [];
  for (const line of mountinfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (!after) continue;
    const fields = before.split(' '),
      details = after.split(' ');
    const version =
      details[0] === 'cgroup2'
        ? 2
        : details[0] === 'cgroup' && details[2]?.split(',').includes('memory')
          ? 1
          : 0;
    if (!version || !fields[3] || !fields[4]) continue;
    const root = unescapeMount(fields[3]),
      mount = unescapeMount(fields[4]);
    if (!absolute(root) || !absolute(mount)) continue;
    for (const group of groups) {
      if (
        !absolute(group.path) ||
        (version === 2
          ? group.controllers !== ''
          : !group.controllers.split(',').includes('memory'))
      )
        continue;
      const relative = posix.relative(root, group.path);
      if (
        relative === '..' ||
        relative.startsWith('../') ||
        posix.isAbsolute(relative)
      )
        continue;
      const directory = posix.resolve(mount, relative);
      const directories = [];
      for (let current = directory; ; current = posix.dirname(current)) {
        directories.push(current);
        if (current === mount) break;
        if (directories.length > 128 || current === '/') return null;
      }
      matches.push({ version, directories, specificity: root.length });
    }
  }
  matches.sort(
    (a, b) => b.version - a.version || b.specificity - a.specificity,
  );
  const selected = matches[0];
  return selected
    ? { version: selected.version, directories: selected.directories }
    : null;
}
/** Every limited ancestor subtracts all of its usage, including sibling containers. Swap is excluded. */
export function cgroupMemoryHeadroom(entries, version = 2) {
  let unknown = entries.length === 0;
  const known = [];
  for (const entry of entries) {
    const limit = entry.limit?.trim();
    const current = entry.current?.trim();
    if (limit === 'max' || (version === 1 && limit === '-1')) continue;
    if (!/^\d+$/u.test(limit ?? '') || !/^\d+$/u.test(current ?? '')) {
      unknown = true;
      continue;
    }
    const remaining = BigInt(limit) - BigInt(current);
    known.push(
      Number(
        remaining < 0n
          ? 0n
          : remaining > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(Number.MAX_SAFE_INTEGER)
            : remaining,
      ),
    );
  }
  return {
    status: unknown ? 'unknown' : known.length ? 'finite' : 'unlimited',
    headroomBytes: known.length ? Math.min(...known) : null,
  };
}
export function effectiveMemoryHeadroom(
  nominal,
  {
    hostAvailableBytes = null,
    cgroup = { status: 'unknown', headroomBytes: null },
  } = {},
) {
  const host = nonnegative(hostAvailableBytes) ? hostAvailableBytes : null;
  const group = nonnegative(cgroup.headroomBytes) ? cgroup.headroomBytes : null;
  const known = [host, group].filter((value) => value !== null);
  const headroom = known.length
    ? Math.min(nominal.memoryBytes, ...known)
    : null;
  const status = !known.length
    ? 'unknown'
    : host === null || cgroup.status === 'unknown'
      ? 'fallback'
      : 'available';
  return {
    ...nominal,
    hostAvailableBytes: host,
    cgroupMemoryStatus: cgroup.status,
    cgroupHeadroomBytes: group,
    memoryHeadroomBytes: headroom,
    memoryReserveBytes: MEMORY_RESERVE_BYTES,
    usableMemoryBytes:
      headroom === null ? 0 : Math.max(0, headroom - MEMORY_RESERVE_BYTES),
    memoryCapacityStatus: status,
  };
}
export async function verificationResources() {
  const optional = async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  const [cpuMax, cpuQuota, cpuPeriod, meminfo, memberships, mounts] =
    process.platform === 'linux'
      ? await Promise.all([
          optional('/sys/fs/cgroup/cpu.max'),
          optional('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
          optional('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
          optional('/proc/meminfo'),
          optional('/proc/self/cgroup'),
          optional('/proc/self/mountinfo'),
        ])
      : [];
  const nominal = effectiveVerificationResources({
    availableCpus: availableParallelism(),
    hostMemoryBytes: totalmem(),
    constrainedMemoryBytes: process.constrainedMemory?.() ?? 0,
    cpuMax,
    cpuQuota,
    cpuPeriod,
  });
  const selected = cgroupMemoryDirectories(memberships, mounts);
  const entries = selected
    ? await Promise.all(
        selected.directories.map(async (directory) => {
          const [limit, current] = await Promise.all([
            optional(
              posix.join(
                directory,
                selected.version === 2 ? 'memory.max' : 'memory.limit_in_bytes',
              ),
            ),
            optional(
              posix.join(
                directory,
                selected.version === 2
                  ? 'memory.current'
                  : 'memory.usage_in_bytes',
              ),
            ),
          ]);
          return { limit, current };
        }),
      )
    : [];
  return effectiveMemoryHeadroom(nominal, {
    hostAvailableBytes: parseMemAvailable(meminfo),
    cgroup: cgroupMemoryHeadroom(entries, selected?.version),
  });
}
const usable = (resources) =>
  nonnegative(resources.usableMemoryBytes) ? resources.usableMemoryBytes : 0;
const fallbackCap = (resources) =>
  resources.memoryCapacityStatus === 'available' ? 4 : 1;
export function verificationResourceMessage(resources, cap) {
  const amount = (bytes) => (bytes / GIB).toFixed(2);
  return `目前最多可執行 ${cap} 組重工作；觀測剩餘 ${resources.memoryHeadroomBytes === null || resources.memoryHeadroomBytes === undefined ? '未知' : amount(resources.memoryHeadroomBytes) + ' GiB'}，每組保留 4 GiB，另保留 0.50 GiB。請釋出記憶體或降低併行數。`;
}
export function verificationConcurrency(requested, resources) {
  const cap = Math.max(
    0,
    Math.min(
      4,
      Math.max(1, Math.floor(resources.cpus / 2)),
      Math.floor(usable(resources) / HEAVY_BYTES),
      fallbackCap(resources),
    ),
  );
  if (!cap)
    fail(
      'VERIFY_RESOURCE_INSUFFICIENT',
      verificationResourceMessage(resources, cap),
    );
  const value = requested === undefined ? Math.min(2, cap) : Number(requested);
  if (!Number.isInteger(value) || value < 1 || value > cap)
    fail(
      'VERIFY_CONCURRENCY_INVALID',
      verificationResourceMessage(resources, cap),
    );
  return value;
}
export function verificationLaneResources(lane, scope, resources) {
  const minimum = lane === 'quality' ? UNIT_BYTES : HEAVY_BYTES;
  if (usable(resources) < minimum)
    fail(
      'VERIFY_RESOURCE_INSUFFICIENT',
      lane === 'quality'
        ? '品質檢查至少需要 2.50 GiB 可用記憶體（含 0.50 GiB 保留量）；請釋出記憶體後重試。'
        : verificationResourceMessage(resources, 0),
    );
  if (scope !== 'full' && scope !== 'quick')
    fail('VERIFY_ARGUMENT_INVALID', '驗證範圍不合法。');
  return resources;
}
export function verificationUnitWorkers(requested, resources) {
  // Config loading may target integration only; the unused unit project must remain loadable.
  const cap = Math.max(
    1,
    Math.min(
      4,
      Math.floor(resources.cpus),
      Math.floor(usable(resources) / UNIT_BYTES),
      fallbackCap(resources),
    ),
  );
  const value = requested === undefined ? Math.min(2, cap) : Number(requested);
  if (!Number.isInteger(value) || value < 1 || value > cap)
    fail(
      'VERIFY_RESOURCE_INVALID',
      `目前單元測試最多可使用 ${cap} 個程序；請降低 FOLIOHAVEN_UNIT_WORKERS。`,
    );
  return value;
}

export function verificationConfiguredUnitWorkers(requested, resources, args) {
  const projects = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--project') projects.push(args[++index]);
    else if (args[index].startsWith('--project='))
      projects.push(args[index].slice('--project='.length));
  }
  const integrationOnly =
    projects.length > 0 &&
    projects.every((project) => project === 'integration');
  return verificationUnitWorkers(
    integrationOnly ? undefined : requested,
    resources,
  );
}
