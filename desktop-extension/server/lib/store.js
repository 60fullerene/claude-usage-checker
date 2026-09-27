// Small JSON files shared by every running copy of the server (Claude Desktop
// can start several: one for chats, more for Code tab sessions).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SNAPSHOT_FILE = 'browser-usage.json'; // the latest report from the browser extension
export const DEMAND_FILE = 'browser-demand.json'; // when Claude last wanted fresher data
export const BRIDGE_FILE = 'browser-bridge.json'; // when the browser extension last checked in

export function defaultCacheDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.CLAUDE_USAGE_CACHE_DIR) return env.CLAUDE_USAGE_CACHE_DIR;
  let base;
  if (platform === 'win32') base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else base = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, '.cache');
  return path.join(base, 'claude-usage-checker');
}

export class Store {
  constructor(directory = defaultCacheDir()) {
    this.directory = directory;
  }

  read(name) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  /** Replace the file atomically so readers never see half-written JSON. */
  write(name, data) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, name);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      // Windows refuses to replace a file another process has open; fall back to rewriting it.
      try {
        fs.writeFileSync(target, JSON.stringify(data), { mode: 0o600 });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      if (!fs.existsSync(target)) throw error;
    }
  }

  readSnapshot() {
    return this.read(SNAPSHOT_FILE);
  }

  readDemandAt() {
    const at = this.read(DEMAND_FILE)?.demand_at;
    return typeof at === 'number' ? at : null;
  }

  writeDemandAt(now) {
    this.write(DEMAND_FILE, { demand_at: now });
  }

  readBridgeSeenAt() {
    const at = this.read(BRIDGE_FILE)?.seen_at;
    return typeof at === 'number' ? at : null;
  }

  writeBridgeSeenAt(now) {
    this.write(BRIDGE_FILE, { seen_at: now });
  }
}
