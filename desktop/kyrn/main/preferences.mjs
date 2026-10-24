import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
export function readJson(path) {
  try {
    return object(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Desktop-owned overrides only. Never accepts paths, endpoints, environment variables or credentials. */
export class Preferences {
  constructor(home, agentDir) {
    this.path = join(home, 'preferences.json');
    this.agentDir = agentDir;
  }
  read() {
    const cli = readJson(join(this.agentDir, 'settings.json'));
    const judge = readJson(join(this.agentDir, 'kyrn.json'));
    const saved = readJson(this.path);
    const inherited = {
      model: cli.defaultProvider && cli.defaultModel ? `${cli.defaultProvider}/${cli.defaultModel}` : '',
      thinking: cli.defaultThinkingLevel || 'medium',
      judge: Array.isArray(judge.tiers) ? judge.tiers.join(',') : 'jev',
      mode: object(judge.modes).default || 'shadow',
    };
    const judges = [...new Set(['jev', 'jev-direct', 'jev-gateway', ...Object.keys(object(judge.judges))])];
    return { defaults: { ...inherited, ...object(saved.defaults) }, projects: object(saved.projects), judges };
  }
  effective(cwd) {
    const config = this.read();
    return { ...config.defaults, ...object(config.projects[cwd]) };
  }
  save(scope, cwd, values) {
    if (!['defaults', 'project'].includes(scope) || (scope === 'project' && !cwd)) throw new Error('请选择配置范围');
    const allowed = ['model', 'thinking', 'judge', 'mode', ...(scope === 'project' ? ['name'] : [])];
    const clean = {};
    const available = this.read().judges;
    for (const [key, value] of Object.entries(object(values))) {
      if (
        !allowed.includes(key) ||
        typeof value !== 'string' ||
        value.length > 300 ||
        /[\r\n]/.test(value) ||
        value.includes('\0')
      )
        throw new Error('无效配置字段');
      if (!value.trim()) continue; // Removing an override restores inheritance.
      if (key === 'model' && !/^[\w.-]+\/[^\s]+$/.test(value)) throw new Error('无效模型');
      if (key === 'thinking' && !THINKING.includes(value)) throw new Error('无效思考强度');
      if (key === 'mode' && !['active', 'shadow', 'off'].includes(value)) throw new Error('无效判断模式');
      if (key === 'judge' && value.split(',').some((name) => !available.includes(name)))
        throw new Error('未知判断模型');
      clean[key] = value.trim();
    }
    const config = readJson(this.path);
    if (scope === 'defaults') config.defaults = clean;
    else config.projects = { ...object(config.projects), [cwd]: clean };
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
    return this.read();
  }
}
