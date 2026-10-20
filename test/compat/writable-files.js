'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Capture only the exact directory just created by the runner. This changes
// file metadata, never deletes files, and never follows links while walking.
function createWritableFinalizer(directory) {
  const root = path.resolve(directory);
  const original = fs.lstatSync(root);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('Generated root must be a real directory');
  const realRoot = fs.realpathSync(root);
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const within = (base, target) => {
    const relative = path.relative(base, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  return function normalizeWritableFiles() {
    const current = fs.lstatSync(root);
    if (current.isSymbolicLink() || !current.isDirectory() || !same(original, current) || fs.realpathSync(root) !== realRoot) throw new Error('Generated root identity changed; refusing metadata changes');
    const result = { changed: 0, skipped: [] };
    function visit(target) {
      const absolute = path.resolve(target);
      if (!within(root, absolute)) throw new Error('Path escaped generated root');
      const stat = fs.lstatSync(absolute);
      const relative = path.relative(root, absolute);
      if (stat.isSymbolicLink()) { result.skipped.push({ path: relative, reason: 'symlink-or-junction' }); return; }
      if (!within(realRoot, fs.realpathSync(absolute))) throw new Error('Resolved path escaped generated root');
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(absolute)) visit(path.join(absolute, name));
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) { result.skipped.push({ path: relative, reason: 'multiple-hardlinks' }); return; }
        if ((stat.mode & 0o200) !== 0) return;
        // Recheck the file and every ancestor immediately before chmod. All
        // owned processes must have closed before the runner invokes this.
        let ancestor = path.dirname(absolute);
        while (ancestor !== root) {
          const parent = fs.lstatSync(ancestor);
          if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Linked ancestor; refusing metadata changes');
          ancestor = path.dirname(ancestor);
        }
        const latestRoot = fs.lstatSync(root);
        const latest = fs.lstatSync(absolute);
        if (!same(original, latestRoot) || latestRoot.isSymbolicLink() || fs.realpathSync(root) !== realRoot || !latest.isFile() || latest.isSymbolicLink() || latest.nlink !== 1 || !same(stat, latest) || !within(realRoot, fs.realpathSync(absolute))) throw new Error('Generated file identity changed; refusing metadata changes');
        fs.chmodSync(absolute, latest.mode | 0o200);
        result.changed++;
      } else result.skipped.push({ path: relative, reason: 'not-a-regular-file' });
    }
    visit(root);
    return result;
  };
}

module.exports = { createWritableFinalizer };
