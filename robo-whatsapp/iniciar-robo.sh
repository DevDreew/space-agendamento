#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Instale o Node.js LTS em https://nodejs.org"; exit 1; }
[ -d node_modules/baileys ] || npm install --omit=dev
[ -f config.json ] || { cp config.exemplo.json config.json; echo "Cole a chave do robô no config.json e rode de novo."; exit 1; }
node robo.mjs
