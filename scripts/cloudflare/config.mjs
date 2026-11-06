import { parseEnv } from 'node:util';
import { z } from 'zod';
import { CloudflareError } from './errors.mjs';
import { hasControl, readOwnerFile, uuidPattern } from './io.mjs';

export const ConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workersPlan: z.enum(['free', 'paid']).default('free'),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  workerName: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  bucketName: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .refine(
      (value) =>
        !value.startsWith('xn--') &&
        !value.endsWith('-s3alias') &&
        !value.endsWith('--ol-s3'),
    ),
});

export function parseConfig(text) {
  try {
    return ConfigSchema.parse(JSON.parse(text));
  } catch {
    throw new CloudflareError(
      'CLOUDFLARE_CONFIG_INVALID',
      'cloudflare.config.json 欄位、名稱或 schemaVersion 不符合範例規格。',
    );
  }
}

export const loadConfig = async (root) =>
  parseConfig(await readOwnerFile(root, 'cloudflare.config.json'));

export function parseCredentials(text) {
  const allowed = [
    'CLOUDFLARE_API_TOKEN',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match =
      /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s#]+)\s*(?:#.*)?$/.exec(
        line,
      );
    if (!match || !allowed.includes(match[1]) || seen.has(match[1]))
      throw new CloudflareError(
        'CLOUDFLARE_CREDENTIAL_INVALID',
        '.env.cloudflare 只接受範例中的三個不重複欄位，不支援插值或多行值。',
      );
    seen.add(match[1]);
  }
  const values = parseEnv(text);
  for (const name of allowed) {
    if (
      !seen.has(name) ||
      typeof values[name] !== 'string' ||
      values[name].length < 16 ||
      values[name].length > 4096 ||
      /\s|[`$]/u.test(values[name]) ||
      hasControl(values[name]) ||
      /YOUR_|PLACEHOLDER|REPLACE_ME/i.test(values[name])
    )
      throw new CloudflareError(
        'CLOUDFLARE_CREDENTIAL_INVALID',
        `請私下設定有效的 ${name}，不可使用範例值。`,
      );
  }
  return values;
}

export const loadCredentials = async (root) =>
  parseCredentials(await readOwnerFile(root, '.env.cloudflare'));

export function parseArguments(args) {
  const [command, ...rest] = args;
  if (!['deploy', 'status', 'restore', 'verify'].includes(command))
    throw new CloudflareError(
      'CLOUDFLARE_ARGUMENT_INVALID',
      '請使用專案提供的 Cloudflare 命令。',
    );
  const result = { command, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (name === '--dry-run' && command === 'deploy' && !result.dryRun) {
      result.dryRun = true;
      continue;
    }
    if (
      (name === '--deployment' &&
        command !== 'deploy' &&
        !result.deploymentId) ||
      (name === '--domain' && command === 'verify' && !result.domain)
    ) {
      const value = rest[++i];
      if (!value || value.startsWith('--'))
        throw new CloudflareError(
          'CLOUDFLARE_ARGUMENT_INVALID',
          '命令參數缺少必要值。',
        );
      if (name === '--deployment') result.deploymentId = value;
      else result.domain = value;
      continue;
    }
    throw new CloudflareError(
      'CLOUDFLARE_ARGUMENT_INVALID',
      '命令含未知、重複或不適用的參數。',
    );
  }
  if (command !== 'deploy' && !uuidPattern.test(result.deploymentId ?? ''))
    throw new CloudflareError(
      'CLOUDFLARE_ARGUMENT_INVALID',
      '--deployment 須為有效的部署 UUID。',
    );
  if (command === 'verify' && !result.domain)
    throw new CloudflareError(
      'CLOUDFLARE_ARGUMENT_INVALID',
      '驗收前須提供已設定完成的 --domain。',
    );
  return result;
}
