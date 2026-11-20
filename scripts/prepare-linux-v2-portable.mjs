// Run after electron-builder --dir --linux. Seeds only the distributable template.
import { access, chmod, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareV2Profile } from './prepare-v2-profile.mjs';

const bundle = resolve(process.argv[2] || 'release/v2-home-alpha7/linux-unpacked');
await access(join(bundle, 'canvastty-v2-alpha'));
await prepareV2Profile(join(bundle, 'profile-template'));
const launcher = join(bundle, 'start-canvastty.sh');
await writeFile(launcher, `#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
export CANVASTTY_USER_DATA_DIR="\${CANVASTTY_USER_DATA_DIR:-$app_dir/profile-alpha7}"
for key in $(compgen -e); do
  case "$key" in CANVASTTY_RUNTIME_*|CANVASTTY_SHELL_*|CANVASTTY_CAPTURE_*|CANVASTTY_MAC_WINDOW_LAB*|CANVASTTY_HOME_LAB_*|CANVASTTY_V2_LAB_*|CANVASTTY_FILES_LAB_*|CANVASTTY_DUO_LAB_*) unset "$key";; esac
done
unset ELECTRON_RUN_AS_NODE
if [[ ! -d "$CANVASTTY_USER_DATA_DIR" ]]; then
  mkdir -p -- "$CANVASTTY_USER_DATA_DIR"
  cp -a -- "$app_dir/profile-template/." "$CANVASTTY_USER_DATA_DIR/"
fi
exec "$app_dir/canvastty-v2-alpha" --ozone-platform=x11 "$@"
`);
await chmod(launcher, 0o755);
await writeFile(join(bundle, 'LINUX-README.ru.md'), `# CanvasTTY 2.0 alpha.7 — portable Linux x64

Распакуйте в отдельную доступную для записи папку и запустите ./start-canvastty.sh.
Первый запуск создаёт отдельный profile-alpha7 рядом с приложением. Существующий
профиль не перезаписывается; CANVASTTY_USER_DATA_DIR задаёт другой путь.
Шаблон содержит оформление, настройки и дополнительный медиаплагин без личных
сессий, ключей, авторизаций и разрешённых папок. Кнопка «Файлы» использует
встроенный проводник; медиаплагин можно открыть отдельно в настройках плагинов.

Импорт окон ОС отменён и не входит в alpha.7. Canvas Duo оставлен: выбранные
текстовые терминалы через LAN/VPN, отдельное разрешение на ввод.

Нужен исправный стандартный Chromium/Electron sandbox; launcher не отключает его.
Скрипт подготовки сам не выполняет Linux runtime-приёмку. Результаты предыдущей
alpha.4 хранятся отдельно и не доказывают работоспособность этой сборки.
Это экспериментальный portable-пакет, не системный установщик.
`);
