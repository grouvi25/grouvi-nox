import fs from 'node:fs';
import { config } from './config.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let state = {
  current: pkg.version,
  latest: pkg.version,
  available: false,
  checkedAt: null,
  releaseUrl: null,
  archiveUrl: null,
  checksumUrl: null,
  error: null,
};

function parts(version) {
  return String(version || '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map(x => Number(x) || 0);
}

function newer(a, b) {
  const av = parts(a); const bv = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] !== bv[i]) return av[i] > bv[i];
  }
  return false;
}

export function updateState() { return { ...state }; }

export async function checkForUpdates() {
  const url = `https://api.github.com/repos/${config.releaseRepo}/releases/latest`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `vps-sentinel/${pkg.version}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const release = await response.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const archive = assets.find(a => /vps-sentinel-v.*-linux\.tar\.gz$/.test(a.name));
    const sums = assets.find(a => a.name === 'SHA256SUMS');
    state = {
      current: pkg.version,
      latest: latest || pkg.version,
      available: Boolean(latest && newer(latest, pkg.version)),
      checkedAt: Date.now(),
      releaseUrl: release.html_url || null,
      archiveUrl: archive?.browser_download_url || null,
      checksumUrl: sums?.browser_download_url || null,
      error: null,
    };
  } catch (error) {
    state = { ...state, checkedAt: Date.now(), error: error.message };
  }
  return updateState();
}

export function startUpdateChecks() {
  checkForUpdates();
  setInterval(checkForUpdates, config.updateCheckIntervalMs).unref();
}
