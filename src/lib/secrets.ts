const cache: Record<string, string> = {};

export function getSecret(name: string): string {
  if (cache[name]) return cache[name];
  const value = process.env[name];
  if (!value) throw new Error(`Secret "${name}" is not set. Add it to .env.local`);
  cache[name] = value;
  return value;
}