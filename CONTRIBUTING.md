# Как помочь

## Локальный запуск

Нужен Node.js 18 или новее, npm-пакеты для ноды и веба не требуются.

```bash
git clone https://github.com/Qatrol/qatrol-node.git
cd qatrol-node
node miner.js    # первый запуск спросит кошелёк
node server.js   # http://localhost:3000
node pool/server.js
```

Тесты гоняются против запущенных процессов:

```bash
node test-api.js
```

## Правила

- Стиль — как в соседнем коде: два пробела, `'use strict'`, `const`, ранние `return`.
- Один PR — одна тема. Рефакторинг отдельно от фикса.
- Новое поведение ломает протокол? Пиши об этом в PR и в `CHANGELOG.md`.
- Не коммить `.env`, `wallets.json`, `blockchain.json`, `node_wallet.json` и `qatrol_wallet_*.txt`. Они в `.gitignore`, проверь `git status` перед пушем.
- Секреты только через переменные окружения.

## Коммиты

Conventional Commits, по-английски, повелительное наклонение:

```
feat(pool): per-worker share difficulty
fix(node): pay block reward from chain genesis
docs(readme): add screenshots
```

## Перед PR

- [ ] `node --check` на изменённых файлах
- [ ] `node test-api.js` — 30/30
- [ ] Живая проверка: нода, веб и пул запускаются, страницы открываются
- [ ] В дифе нет секретов и рантайм-данных
