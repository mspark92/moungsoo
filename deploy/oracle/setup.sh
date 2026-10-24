#!/usr/bin/env bash
# One-time setup on an Oracle Cloud "Always Free" Ubuntu VM (x86 or Ampere ARM).
# Run as the default `ubuntu` user:  bash setup.sh
# Installs Node.js 24, Caddy (automatic HTTPS), the app as a systemd service and
# a weekday 09:00 Asia/Seoul update timer. Secrets are generated on the server
# into /etc/moungsoo/env (root-only) and never printed.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mspark92/moungsoo.git}"
APP_DIR=/opt/moungsoo
DATA_DIR=/var/lib/moungsoo
ENV_FILE=/etc/moungsoo/env
PUBLIC_IP="$(curl -fsS https://ifconfig.me || curl -fsS https://api.ipify.org)"
# sslip.io maps 1-2-3-4.sslip.io to 1.2.3.4 without any sign-up, so Caddy can
# obtain a Let's Encrypt certificate for the bare IP. Set DOMAIN to use your own.
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"

echo "[1/7] 패키지 설치"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https iptables-persistent
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "[2/7] 방화벽(서버 내부) 80·443 허용"
# Oracle's Ubuntu images reject everything except SSH in iptables by default.
for p in 80 443; do sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp -m state --state NEW --dport "$p" -j ACCEPT; done
sudo netfilter-persistent save

echo "[3/7] 앱 내려받기"
sudo useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin moungsoo 2>/dev/null || true
if [ -d "$APP_DIR/.git" ]; then sudo git -C "$APP_DIR" pull --ff-only; else sudo git clone "$REPO_URL" "$APP_DIR"; fi
sudo mkdir -p "$DATA_DIR" /etc/moungsoo && sudo chown moungsoo:moungsoo "$DATA_DIR" && sudo chmod 700 "$DATA_DIR"

echo "[4/7] 비밀값 생성 (/etc/moungsoo/env)"
if [ ! -f "$ENV_FILE" ]; then
  sudo tee "$ENV_FILE" >/dev/null <<EOF
HOST=127.0.0.1
PORT=3000
PUBLIC_HOSTS=$DOMAIN
DATA_DIR=$DATA_DIR
ADMIN_TOKEN=$(openssl rand -base64 36 | tr -d '\n/+=' | cut -c1-40)
LAW_UPDATE_SIGNING_KEY=$(openssl rand -hex 32)
LAW_API_OC=
HOLIDAY_API_KEY=
EOF
fi
sudo chown root:moungsoo "$ENV_FILE" && sudo chmod 640 "$ENV_FILE"

echo "[5/7] 서비스 등록"
sudo cp "$APP_DIR/deploy/oracle/moungsoo.service" "$APP_DIR/deploy/oracle/moungsoo-update.service" "$APP_DIR/deploy/oracle/moungsoo-update.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moungsoo.service moungsoo-update.timer

echo "[6/7] HTTPS 설정 ($DOMAIN)"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "[7/7] 확인"
sleep 3
curl -fsS -o /dev/null -w "앱 응답: %{http_code}\n" -H "Host: 127.0.0.1:3000" http://127.0.0.1:3000/api/status
echo
echo "완료: https://$DOMAIN"
echo "서버 공인 IP: $PUBLIC_IP  ← 법제처 OPEN API(OC) 신청 정보에 이 IP를 등록하세요."
echo "관리자 토큰 확인: sudo grep ADMIN_TOKEN $ENV_FILE"
echo "OC 입력: sudo nano $ENV_FILE  (LAW_API_OC=... 저장 후 sudo systemctl restart moungsoo)"
