# Рейтинг для magic-battle-server

## Файлы
- `rating.js` — роутер Express

## Как подключить на Railway

### 1. Скачай текущий код сервера
В Railway → твой проект → Settings → подключи GitHub-репозиторий сервера
или скачай исходники, если они у тебя локально.

### 2. Положи rating.js рядом с основным файлом сервера
Обычно это `server.js` или `index.js`.

### 3. В основном файле сервера добавь:

```js
const ratingRouter = require('./rating');
app.use('/rating', ratingRouter);
```

Пример:

```js
const express = require('express');
const app = express();
app.use(express.json());

// ... существующие роуты кланов ...

const ratingRouter = require('./rating');
app.use('/rating', ratingRouter);

app.listen(process.env.PORT || 3000);
```

### 4. Задеплой
- Закоммить и запушь в репозиторий, который смотрит Railway
- Или в Railway → Deployments → Redeploy

### 5. Проверь
```bash
# Запись
curl -X POST https://magic-battle-server-production.up.railway.app/rating \
  -H "Content-Type: application/json" \
  -d '{"id":"player123","name":"Герой","power":500,"level":10}'

# Чтение
curl https://magic-battle-server-production.up.railway.app/rating
```

## Важно
Сейчас хранилище in-memory. При рестарте контейнера данные пропадут.
Для постоянства замени `Map` на Redis или Postgres (Railway имеет оба).
