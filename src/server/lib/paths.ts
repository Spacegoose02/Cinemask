import fs from 'node:fs';
import path from 'node:path';

function realish(p: string): string {
  // Resolve symlinks on the deepest part of the path that exists.
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.existsSync(cur) ? fs.realpathSync(cur) : cur, ...rest);
}

/** True when target is strictly inside root, symlinks included. The root itself never counts. */
export function insideRoot(root: string, target: string): boolean {
  if (!root) return false;
  const r = realish(root) + path.sep;
  return realish(target).startsWith(r);
}
