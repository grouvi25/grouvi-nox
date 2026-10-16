import crypto from 'node:crypto';
import path from 'node:path';

/**
 * What the change broker is willing to do, and how loudly it asks first.
 *
 * Two tiers, deliberately not three: a routine change is applied on one click,
 * a dangerous one additionally needs a fresh passkey assertion. Nothing here
 * refuses to run something just because it is powerful — restarting containers
 * and rewriting configs is the point. The tiers only decide how much friction
 * stands between a model's proposal and root.
 */

export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SCRIPT_CHARS = 8000;
export const MAX_TIMEOUT_SEC = 900;
export const DEFAULT_TIMEOUT_SEC = 120;
export const KINDS = ['patch', 'file', 'command'];

const SELF = /(?:\/opt\/vps-sentinel|\/var\/lib\/vps-sentinel|\/etc\/vps-sentinel|\/var\/lib\/sentinel-ai|\/etc\/sentinel-ai|\bvps-sentinel(?:-[a-z]+)?(?:\.service|\.timer)?\b|\bsentinel-ai(?:-[a-z]+)?\b|\bnoxctl\b|\bsentinelctl\b|\bchange-broker\b)/;

/* Things that can lock the operator out, destroy data wholesale or hand the
   host to someone else. Matched against the whole script. */
const DANGEROUS_SCRIPT = [
  [/\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs|fdisk|parted|sfdisk|cryptsetup|pvremove|vgremove|lvremove)\b/, 'disk or filesystem tooling'],
  [/\bdd\b[^\n;|&]*\bof=/, 'raw write with dd'],
  [/>\s*\/dev\/(?:sd|nvme|vd|xvd|disk)/, 'write to a block device'],
  [/\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b|\bsystemctl\s+(?:reboot|poweroff|halt|kexec)\b/, 'power state'],
  [/\b(?:iptables|ip6tables|ufw|nft|firewall-cmd|fail2ban-client)\b/, 'firewall'],
  [/\/etc\/ssh\b|\bsshd?(?:_config)?\b|authorized_keys|\bssh-keygen\b/, 'SSH access'],
  [/\b(?:useradd|userdel|usermod|groupadd|groupdel|passwd|chpasswd|visudo|adduser|deluser)\b|\/etc\/(?:sudoers|passwd|shadow|group|gshadow)/, 'users and privileges'],
  [/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, 'pipes a download into a shell'],
  [/\bapt(?:-get)?\s+(?:-[a-z-]+\s+)*(?:remove|purge|autoremove|dist-upgrade|full-upgrade)\b|\b(?:dpkg\s+(?:-P|--purge|-r|--remove))\b/, 'package removal or distro upgrade'],
  [/\bdocker\s+(?:system\s+prune|volume\s+(?:rm|prune)|network\s+prune|image\s+prune\s+-a)\b/, 'docker data removal'],
  [/\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(?:;|$|"|'))/i, 'destructive SQL'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+(?:-f|--force))/, 'discards git work'],
  [/\bsystemctl\s+(?:disable|mask|stop)\s+(?:--now\s+)?(?:ssh|sshd|nginx|docker|containerd|networking|systemd-networkd|cloudflared)\b/, 'stops a core service'],
  [/\b(?:crontab\s+-r|chattr|setfacl\s+-R|chmod\s+-R\s+[0-7]*7\b)/, 'permissions or cron wipe'],
  [/\b(?:chown|chmod)\s+-R\s+\S+\s+\/(?:\s|$|etc|usr|var|bin|boot|root|home)/, 'recursive permissions on system paths'],
];

const SENSITIVE_PATH = [
  [/(?:^|\/)\.env(?:\.[\w.-]+)?$/, 'environment file'],
  [/(?:^|\/)(?:id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys|known_hosts)$|\.(?:pem|key|p12|pfx|kdbx)$/, 'key material'],
  [/^\/etc\/(?:ssh|sudoers|passwd|shadow|group|gshadow|cron\.[a-z]+|crontab|fstab|hosts|resolv\.conf|ld\.so)/, 'system access file'],
  [/^\/root\/\.ssh\//, 'root SSH directory'],
  [/(?:^|\/)\.(?:git-credentials|netrc|npmrc|pypirc|aws|docker\/config\.json|kube\/config)/, 'credential store'],
  [/^\/(?:etc\/systemd|lib\/systemd|usr\/lib\/systemd|etc\/init\.d|etc\/profile|etc\/environment|etc\/pam\.d|etc\/security|etc\/ssl\/private|etc\/rc[0-9S.]*|usr\/local\/s?bin|usr\/s?bin|s?bin)\b/, 'startup or system executable'],
  [/^\/root\/\.(?:bashrc|profile|bash_profile|bash_login)$/, 'root shell startup'],
];

const SAFE_RM_TARGET = /(?:^|\/)(?:node_modules|dist|build|\.cache|\.next|\.nuxt|__pycache__|\.pytest_cache|\.turbo|coverage|target|\.parcel-cache|tmp|\.tmp)\/?$/;

function segments(script) {
  return script.split(/\n|;|&&|\|\||\|(?!\|)/).map(s => s.trim()).filter(Boolean);
}

function recursiveRmUnsafe(script) {
  for (const segment of segments(script)) {
    const tokens = segment.replace(/^(?:sudo|command|exec)\s+/, '').split(/\s+/);
    if (tokens[0] !== 'rm') continue;
    const flags = tokens.filter(t => /^-/.test(t)).join('');
    if (!/[rR]/.test(flags) && !tokens.includes('--recursive')) continue;
    const targets = tokens.slice(1).filter(t => !/^-/.test(t));
    if (!targets.length) return true;
    for (const raw of targets) {
      const target = raw.replace(/^["']|["']$/g, '');
      if (/[*$`]/.test(target) && !SAFE_RM_TARGET.test(target)) return true;
      if (target.startsWith('/tmp/') && !target.includes('..')) continue;
      if (SAFE_RM_TARGET.test(target) && !target.includes('..')) continue;
      return true;
    }
  }
  return false;
}

/* Characters that make text read differently from what it executes: right-to-left
   overrides, zero-width joiners, other invisible controls. The operator reviews
   exactly what they can see, so anything hidden is itself a reason to stop. */
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
export const hasHiddenCharacters = value => HIDDEN.test(String(value ?? ''));

export function classifyScript(script) {
  const text = String(script || '');
  const reasons = [];
  for (const [pattern, reason] of DANGEROUS_SCRIPT) if (pattern.test(text)) reasons.push(reason);
  if (recursiveRmUnsafe(text)) reasons.push('recursive delete');
  if (SELF.test(text)) reasons.push('touches Nox itself');
  return reasons;
}

export function classifyPath(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const reasons = [];
  for (const [pattern, reason] of SENSITIVE_PATH) if (pattern.test(normalized)) reasons.push(reason);
  if (SELF.test(normalized)) reasons.push('touches Nox itself');
  return reasons;
}

/** @returns {{tier:'routine'|'dangerous', reasons:string[]}} */
export function classifyProposal(proposal) {
  const reasons = new Set();
  const scripts = [...(proposal.post || []), proposal.undo, proposal.validate, proposal.command?.script, proposal.healthcheck?.script].filter(Boolean);
  const visible = [...scripts, proposal.title, proposal.why, proposal.patch?.diff, proposal.file?.content, proposal.file?.path, proposal.command?.cwd];
  if (visible.some(hasHiddenCharacters)) reasons.add('contains hidden control characters');
  for (const script of scripts) for (const reason of classifyScript(script)) reasons.add(reason);
  if (proposal.kind === 'patch') for (const file of proposal.patch?.files || []) for (const reason of classifyPath(file)) reasons.add(reason);
  if (proposal.kind === 'file') for (const reason of classifyPath(proposal.file?.path)) reasons.add(reason);
  return { tier: reasons.size ? 'dangerous' : 'routine', reasons: [...reasons] };
}

/* -------------------------------------------------------------------- *
 * Proposal shape                                                        *
 * -------------------------------------------------------------------- */

const ID = /^[a-z0-9][a-z0-9_-]{5,63}$/i;
const NODE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const text = (value, max) => String(value ?? '').slice(0, max);
const script = (value, field) => {
  const s = String(value ?? '');
  if (!s.trim()) throw new Error(`empty_${field}`);
  if (s.length > MAX_SCRIPT_CHARS) throw new Error(`${field}_too_long`);
  if (s.includes('\0')) throw new Error(`${field}_invalid`);
  return s;
};

/** Paths inside a unified diff, with the checks that keep a patch in its project. */
export function diffPaths(diff) {
  const files = new Set();
  const symlinkCreation = /^(?:new|old) file mode 120000$/m.test(diff);
  for (const line of diff.split('\n')) {
    let match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) { files.add(match[1]); files.add(match[2]); continue; }
    match = /^(?:---|\+\+\+) (?:a|b)\/(.+)$/.exec(line);
    if (match) files.add(match[1].replace(/\t.*$/, ''));
  }
  return { files: [...files].filter(f => f !== '/dev/null'), symlinkCreation };
}

function validatePatchPath(file) {
  const normalized = path.posix.normalize(file);
  if (path.posix.isAbsolute(normalized) || normalized.startsWith('..') || normalized.split('/').includes('..')) throw new Error('patch_path_escapes_project');
  if (normalized === '.git' || normalized.startsWith('.git/') || normalized.includes('/.git/')) throw new Error('patch_touches_git_dir');
  return normalized;
}

export function normalizeProposal(input) {
  if (!input || typeof input !== 'object') throw new Error('bad_proposal');
  const kind = String(input.kind);
  if (!KINDS.includes(kind)) throw new Error('bad_kind');
  const id = String(input.id || '');
  if (!ID.test(id)) throw new Error('bad_id');
  const node = String(input.node || 'local');
  if (node !== 'local' && !NODE.test(node)) throw new Error('bad_node');

  const out = {
    schema: 1,
    id,
    node,
    scope: text(input.scope || 'vps', 80),
    kind,
    title: text(input.title, 160).trim(),
    why: text(input.why, 2000).trim(),
    createdAt: Number(input.createdAt) || 0,
    post: [],
  };
  if (!out.title) throw new Error('missing_title');

  if (kind === 'patch') {
    const source = input.patch || {};
    const projectPath = String(source.projectPath || '');
    if (!path.posix.isAbsolute(projectPath) || projectPath.includes('\0') || projectPath === '/') throw new Error('bad_project_path');
    const diff = String(source.diff || '');
    if (!diff.trim()) throw new Error('empty_diff');
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw new Error('diff_too_large');
    const { files, symlinkCreation } = diffPaths(diff);
    if (!files.length) throw new Error('diff_has_no_files');
    if (symlinkCreation) throw new Error('patch_creates_symlink');
    out.patch = {
      projectPath: path.posix.normalize(projectPath),
      base: /^[0-9a-f]{7,64}$/.test(String(source.base || '')) ? String(source.base) : '',
      diff: diff.endsWith('\n') ? diff : `${diff}\n`,
      files: files.map(validatePatchPath),
    };
  } else if (kind === 'file') {
    const source = input.file || {};
    const target = String(source.path || '');
    if (!path.posix.isAbsolute(target) || target.includes('\0') || target.split('/').includes('..') || target.endsWith('/')) throw new Error('bad_file_path');
    const content = String(source.content ?? '');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('file_too_large');
    out.file = { path: path.posix.normalize(target), content };
    if (input.validate) out.validate = script(input.validate, 'validate');
  } else {
    const source = input.command || {};
    out.command = {
      script: script(source.script, 'script'),
      cwd: source.cwd ? String(source.cwd) : '/',
      timeoutSec: Math.min(MAX_TIMEOUT_SEC, Math.max(5, Number(source.timeoutSec) || DEFAULT_TIMEOUT_SEC)),
    };
    if (!path.posix.isAbsolute(out.command.cwd) || out.command.cwd.includes('\0')) throw new Error('bad_cwd');
  }

  for (const step of Array.isArray(input.post) ? input.post.slice(0, 8) : []) out.post.push(script(step, 'post'));
  if (input.undo) out.undo = script(input.undo, 'undo');
  if (input.healthcheck) {
    const h = input.healthcheck;
    const check = {
      retries: Math.min(60, Math.max(1, Number(h.retries) || 10)),
      delaySec: Math.min(60, Math.max(1, Number(h.delaySec) || 3)),
    };
    if (h.url) {
      let parsed;
      try { parsed = new URL(String(h.url)); } catch { throw new Error('bad_healthcheck_url'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad_healthcheck_url');
      check.url = parsed.toString();
      check.expectStatus = Number(h.expectStatus) || 0;
    } else if (h.script) check.script = script(h.script, 'healthcheck');
    else throw new Error('empty_healthcheck');
    out.healthcheck = check;
  }
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** What the operator approves is exactly this hash; any later edit changes it. */
export function proposalHash(proposal) {
  return crypto.createHash('sha256').update(stable(proposal)).digest('hex');
}

/* -------------------------------------------------------------------- *
 * Read-only probes for the agent                                        *
 * -------------------------------------------------------------------- */

const READERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'grep', 'find', 'readlink', 'sha256sum', 'md5sum', 'tree']);
const PLAIN = new Set(['ss', 'df', 'free', 'uptime', 'ps', 'whoami', 'id', 'hostname', 'uname', 'date', 'lsblk', 'ip', 'dig', 'nslookup', 'lsof', 'mount', 'findmnt']);
const IP_MUTATION = new Set(['set', 'add', 'del', 'delete', 'flush', 'change', 'replace', 'append', 'prepend', 'exec', 'netns', 'monitor', 'up', 'down', 'save', 'restore', 'tuntap', 'batch', '-b', '-batch', '-force']);
const SUBCOMMANDS = {
  docker: new Set(['ps', 'logs', 'images', 'stats', 'top', 'port', 'info', 'version', 'diff', 'events']),
  systemctl: new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-timers', 'list-sockets', 'show', 'cat', 'list-unit-files', 'list-dependencies']),
  pm2: new Set(['list', 'ls', 'jlist', 'status', 'describe', 'show', 'prettylist']),
  nginx: new Set(['-t', '-T', '-v', '-V']),
};
const JOURNAL_WRITE = /^--(?:vacuum|rotate|flush|relinquish|smart-relinquish|sync|setup-keys|update-catalog|new-id128|rotate)/;
const SENSITIVE_READ = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys|\.git-credentials|\.netrc|\.npmrc|\.pypirc|shadow|gshadow|sudoers(?:\.d)?|credentials?|secrets?|[^/]*\.(?:pem|key|p12|pfx|kdbx)|sentinel\.db(?:-wal|-shm)?|state\.json|integration-config\.sock)(?:\/|$)|\/proc\/[^/]+\/(?:environ|mem)|\/etc\/(?:vps-sentinel|sentinel-ai)\.env|\/\.ssh\/|\/\.hermes\/|^\/var\/lib\/(?:postgresql|mysql|mariadb|redis|mongodb|docker\/volumes)\b|^\/etc\/(?:ssl\/private|letsencrypt\/(?:archive|live|accounts)|wireguard|openvpn)\b|\/\.(?:kube|aws|docker|config\/gcloud)\/|^\/var\/backups\b|^\/etc\/(?:shadow|gshadow|sudoers)/i;

export const isSensitiveRead = value => SENSITIVE_READ.test(String(value));

export function probeAllowed(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 40) return { ok: false, reason: 'bad_argv' };
  const args = argv.map(String);
  if (args.some(a => a.includes('\0') || a.length > 600)) return { ok: false, reason: 'bad_argument' };
  const [cmd, ...rest] = args;
  const base = path.posix.basename(cmd);
  if (base !== cmd) return { ok: false, reason: 'command_must_be_bare_name' };
  const paths = rest.filter(a => !a.startsWith('-') || a.includes('/'));
  if (paths.some(a => SENSITIVE_READ.test(a))) return { ok: false, reason: 'sensitive_path' };

  if (READERS.has(cmd)) {
    if (cmd === 'find' && rest.some(a => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) return { ok: false, reason: 'find_action_not_read_only' };
    // A recursive grep would read every .env under the tree; the agent has its
    // own checkout to search, so the host-wide form is simply not offered.
    if (cmd === 'grep' && rest.some(a => /^-[a-zA-Z]*[rR]|^--recursive|^--dereference-recursive|^-d$|^--directories|^-f$|^--file/.test(a))) return { ok: false, reason: 'grep_recursive_or_file_patterns' };
    return { ok: true };
  }
  if (PLAIN.has(cmd)) {
    if (cmd === 'ip' && rest.some(a => IP_MUTATION.has(a))) return { ok: false, reason: 'ip_mutation' };
    if (cmd === 'mount' && rest.length) return { ok: false, reason: 'mount_mutation' };
    return { ok: true };
  }
  if (cmd === 'journalctl') return rest.some(a => JOURNAL_WRITE.test(a)) ? { ok: false, reason: 'journal_mutation' } : { ok: true };
  if (cmd === 'docker') {
    const sub = rest[0];
    if (sub === 'compose') {
      const compose = rest.find((a, i) => i > 0 && !a.startsWith('-') && !(rest[i - 1] === '-f' || rest[i - 1] === '--file' || rest[i - 1] === '-p' || rest[i - 1] === '--project-name'));
      return ['ps', 'logs', 'ls', 'top', 'images', 'port', 'version'].includes(compose) ? { ok: true } : { ok: false, reason: 'compose_subcommand_not_read_only' };
    }
    if (sub === 'inspect') {
      const format = rest.findIndex(a => a === '--format' || a === '-f' || a.startsWith('--format='));
      const value = format < 0 ? '' : (rest[format].includes('=') ? rest[format].split('=').slice(1).join('=') : rest[format + 1] || '');
      return format >= 0 && !/Env|Config\b|Cmd|Entrypoint/.test(value) ? { ok: true } : { ok: false, reason: 'docker_inspect_needs_safe_format' };
    }
    if (['network', 'volume', 'image', 'container', 'system'].includes(sub)) return ['ls', 'df', 'history'].includes(rest[1]) ? { ok: true } : { ok: false, reason: 'docker_subcommand_not_read_only' };
    return SUBCOMMANDS.docker.has(sub) ? { ok: true } : { ok: false, reason: 'docker_subcommand_not_read_only' };
  }
  if (cmd === 'systemctl') {
    const sub = rest.find(a => !a.startsWith('-'));
    if (!SUBCOMMANDS.systemctl.has(sub)) return { ok: false, reason: 'systemctl_subcommand_not_read_only' };
    // `show` prints Environment= for the unit, which is where secrets live.
    if (sub === 'show') {
      const props = rest.filter((a, i) => /^(?:-p|--property)$/.test(rest[i - 1] || '') || /^--property=/.test(a));
      if (!props.length || props.some(p => /environment/i.test(p))) return { ok: false, reason: 'systemctl_show_needs_safe_properties' };
    }
    return { ok: true };
  }
  if (cmd === 'pm2') {
    const sub = rest[0];
    if (sub === 'logs') return rest.includes('--nostream') ? { ok: true } : { ok: false, reason: 'pm2_logs_needs_nostream' };
    return SUBCOMMANDS.pm2.has(sub) ? { ok: true } : { ok: false, reason: 'pm2_subcommand_not_read_only' };
  }
  if (cmd === 'nginx') return rest.length === 1 && SUBCOMMANDS.nginx.has(rest[0]) ? { ok: true } : { ok: false, reason: 'nginx_only_test_or_dump' };
  if (cmd === 'git') {
    let i = 0;
    while (rest[i] === '-C') i += 2;
    const sub = rest[i];
    if (!['log', 'status', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag', 'shortlog', 'config'].includes(sub)) return { ok: false, reason: 'git_subcommand_not_read_only' };
    if (rest.some(a => /^--output|^-c$|^--exec-path|^--upload-pack|^-[a-z]*D$|^--delete|^--set-upstream/.test(a))) return { ok: false, reason: 'git_flag_not_read_only' };
    if (sub === 'config' && !rest.includes('--get') && !rest.includes('-l') && !rest.includes('--list')) return { ok: false, reason: 'git_config_write' };
    if (sub === 'branch' && rest.slice(i + 1).some(a => !a.startsWith('-') )) return { ok: false, reason: 'git_branch_write' };
    if (sub === 'tag' && rest.slice(i + 1).some(a => !a.startsWith('-'))) return { ok: false, reason: 'git_tag_write' };
    return { ok: true };
  }
  return { ok: false, reason: 'command_not_in_probe_allowlist' };
}

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]+@/gi, '$1[redacted]@'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted jwt]'],
  [/(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)[^\s"',;]+/gi, '$1[redacted]'],
  [/\b(?:sk|ghp|gho|ghs|github_pat|xox[bpa]|glpat|AKIA)[-_A-Za-z0-9]{16,}/g, '[redacted token]'],
  [/((?:token|secret|passw(?:or)?d|api[_-]?key|authorization|bearer|private[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"',;]{4,}/gi, '$1[redacted]'],
];

export function redact(value) {
  let out = String(value ?? '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}
