# Magic Battle Server

Бэкенд для **Heroes of Astoria — Magic Battle**: рейтинг, кланы, урон по боссу.

- Без `npm install` — только Node.js 18+
- Совместим с клиентским `js/net.js`

## Файлы

| Файл | Назначение |
|------|------------|
| `server.js` | HTTP API + WebSocket |
| `db.js` | Хранение в `data/db.json` |
| `package.json` | `npm start` → `node server.js` |
| `index-html-snippet.txt` | Что вставить в игру |

## API

| Метод | Путь | Зачем |
|--------|------|--------|
| GET | `/health` | Проверка |
| POST | `/players/upsert` | Игрок (имя, сила, уровень) |
| GET | `/rating?by=power&limit=50` | Топ |
| GET | `/clans/:id` | Клан + HP босса + урон |
| POST | `/clans/:id/battle` | Засчитать урон |
| POST | `/clans/:id/donate` | Донат |
| POST | `/clans/:id/build` | Постройка |
| POST | `/clans/:id/chest` | Сундук активности |
| WS | `/ws?clanId=` | Live-обновления |

---

## 1. Локально (проверка)

```bash
cd magic-battle-server
node server.js
```

Браузер: http://localhost:3000/health → `{"ok":true,...}`

---

## 2. GitHub

1. https://github.com/new  
2. Имя: `magic-battle-server` → **Create repository**  
3. **uploading an existing file** → загрузите все файлы папки → **Commit**

---

## 3. Railway (хостинг)

1. https://railway.app → **Login with GitHub**  
2. **New Project** → **Deploy from GitHub repo** → `magic-battle-server`  
3. Дождитесь **Success**  
4. **Settings** → **Networking** → **Generate Domain**  
5. Скопируйте URL, например:  
   `https://magic-battle-server-production-xxxx.up.railway.app`

Откройте: `https://ВАШ-ДОМЕН/health` — должен ответить ok.

---

## 4. Подключить игру

В `index.html` **перед** `<script src="js/sprites.js">`:

```html
<script>
  window.MB_NET_CONFIG = {
    mode: 'remote',
    apiUrl: 'https://ВАШ-ДОМЕН.up.railway.app',
    wsUrl:  'wss://ВАШ-ДОМЕН.up.railway.app/ws',
    pollMs: 4000
  };
</script>
```

- Без `/` в конце `apiUrl`  
- Игру открывать по `http://` (Live Server), не `file://`

---

## 5. Проверка сети

1. Два браузера (обычный + инкогнито)  
2. Клан → бой с боссом в одном  
3. Во втором через ~4 с обновится HP и урон  

Общий id клана по умолчанию: `global_astoria_clan`.
