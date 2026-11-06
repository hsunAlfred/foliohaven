/** 子程序只繼承工具鏈所需設定；process token及認證不傳給build/lifecycle。 */
export function buildProcessEnvironment(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    NPM_CONFIG_USERCONFIG: '/dev/null',
  };
  for (const name of [
    'PATH',
    'HOME',
    'PNPM_HOME',
    'PLAYWRIGHT_BROWSERS_PATH',
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...extra };
}
