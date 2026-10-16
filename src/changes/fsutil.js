import fs from 'node:fs';

/**
 * Reads a regular file through one open descriptor.
 *
 * Checking a path and then reading it leaves a window in which the path can be
 * swapped for a link or a different file. Opening once, refusing links at open
 * time and inspecting the descriptor itself closes that window.
 *
 * @returns {Buffer|string|null} null when the path is missing, a link, not a regular file or too large
 */
export function readRegularFile(file, { maxBytes = Infinity, encoding } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(fd, encoding);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
