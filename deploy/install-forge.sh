#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HERMES_REPO=${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}
HERMES_REF=${HERMES_REF:-v2026.7.30}
HERMES_COMMIT=${HERMES_COMMIT:-cc4cab2f592e60a197e796506de9168f74baf3ea}
AI_BASE_URL=${AI_BASE_URL:-https://api.example.com/v1}
AI_MODEL=${AI_MODEL:-Qwen3.6-35B-A3B}
AI_FALLBACK_MODEL=${AI_FALLBACK_MODEL:-DeepSeek-V4-Pro}
AI_PROVIDER_LABEL=${AI_PROVIDER_LABEL:-OpenAI compatible}
AI_API_KEY=${AI_API_KEY:-}
AI_BACKUP_KEYS=${AI_BACKUP_KEYS:-}
DRY_RUN=${DRY_RUN:-0}
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Forge installer requires root.' >&2; exit 1; }
[[ -f $SCRIPT_DIR/forge/server.mjs && -f $SCRIPT_DIR/forge/bridge.service ]] || { echo 'Forge bundle incomplete.' >&2; exit 1; }
[[ $AI_BASE_URL == https://* ]] || { echo 'AI_BASE_URL must use HTTPS.' >&2; exit 1; }
if ((DRY_RUN));then command -v git >/dev/null;command -v python3 >/dev/null;command -v node >/dev/null;echo "Forge plan: Hermes $HERMES_REF ($HERMES_COMMIT), isolated user, local socket, provider $AI_BASE_URL, model $AI_MODEL";exit 0;fi
if ! id sentinel-ai >/dev/null 2>&1;then useradd --system --create-home --home-dir /var/lib/sentinel-ai --shell /usr/sbin/nologin sentinel-ai;fi
usermod -aG adm,systemd-journal sentinel-ai 2>/dev/null||true
install -d -m 750 -o sentinel-ai -g sentinel-ai /var/lib/sentinel-ai /var/lib/sentinel-ai/.hermes /var/lib/sentinel-ai/context /var/lib/sentinel-ai/workspace /var/lib/sentinel-ai/workspace/repos
install -d -m 755 -o root -g root /opt/sentinel-ai
if [[ ! -d /opt/sentinel-ai/source/.git ]];then
  rm -rf /opt/sentinel-ai/source;git clone --filter=blob:none --no-checkout "$HERMES_REPO" /opt/sentinel-ai/source
fi
git -C /opt/sentinel-ai/source fetch --force --depth 1 origin "refs/tags/$HERMES_REF:refs/tags/$HERMES_REF"
git -C /opt/sentinel-ai/source checkout --force --detach "$HERMES_REF"
actual=$(git -C /opt/sentinel-ai/source rev-parse HEAD);[[ $actual == "$HERMES_COMMIT" ]]||{ echo "Hermes pin mismatch: $actual" >&2;exit 1; }
python3 -m venv /opt/sentinel-ai/venv
/opt/sentinel-ai/venv/bin/python -m pip install --quiet --upgrade pip setuptools wheel
/opt/sentinel-ai/venv/bin/python -m pip install --quiet -e /opt/sentinel-ai/source
install -m 755 "$SCRIPT_DIR/forge/sentinel-hermes" /usr/local/bin/sentinel-hermes
cat >/var/lib/sentinel-ai/.hermes/config.yaml <<EOF
model:
  default: $AI_MODEL
  provider: custom:sentinel
  context_length: 131072
  max_tokens: 8192
terminal:
  backend: local
  cwd: /var/lib/sentinel-ai/workspace
  timeout: 120
  lifetime_seconds: 300
  home_mode: profile
compression:
  enabled: true
  proactive_prune_tokens: 48000
providers:
  sentinel:
    name: $AI_PROVIDER_LABEL
    base_url: $AI_BASE_URL
    key_env: SENTINEL_AI_API_KEY
    api_mode: chat_completions
    default_model: $AI_MODEL
EOF
chown sentinel-ai:sentinel-ai /var/lib/sentinel-ai/.hermes/config.yaml;chmod 600 /var/lib/sentinel-ai/.hermes/config.yaml
umask 077
cat >/etc/sentinel-ai.env <<EOF
HOME=/var/lib/sentinel-ai
HERMES_HOME=/var/lib/sentinel-ai/.hermes
SENTINEL_AI_API_KEY=$AI_API_KEY
SENTINEL_AI_MODEL=$AI_MODEL
SENTINEL_AI_FALLBACK_MODEL=$AI_FALLBACK_MODEL
EOF
index=1;IFS=',' read -ra backup_keys <<<"$AI_BACKUP_KEYS";for key in "${backup_keys[@]}";do key=${key//[$'\r\n']/};[[ -n $key ]]||continue;printf 'SENTINEL_AI_API_KEY_BACKUP_%s=%s\n' "$index" "$key" >>/etc/sentinel-ai.env;index=$((index+1));((index<=5))||break;done
chmod 600 /etc/sentinel-ai.env;chown root:root /etc/sentinel-ai.env
install -m 644 "$SCRIPT_DIR/forge/bridge.service" /etc/systemd/system/sentinel-ai-bridge.service
install -m 644 "$SCRIPT_DIR/forge/context.service" /etc/systemd/system/sentinel-ai-context.service
install -m 644 "$SCRIPT_DIR/forge/context.timer" /etc/systemd/system/sentinel-ai-context.timer
systemctl daemon-reload
systemctl enable --now sentinel-ai-context.timer
systemctl start sentinel-ai-context.service
systemctl enable --now sentinel-ai-bridge.service
for _ in {1..30};do [[ -S /run/sentinel-ai/bridge.sock ]]&&break;sleep 1;done
[[ -S /run/sentinel-ai/bridge.sock ]]||{ journalctl -u sentinel-ai-bridge -n 80 --no-pager;exit 1; }
echo "Sentinel Forge installed: Hermes $HERMES_REF, bridge active, provider $([[ -n $AI_API_KEY ]]&&echo configured||echo pending-dashboard-setup)."