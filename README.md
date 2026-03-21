# LIDERS CHAT — Signal Server

HTTP long-polling сигнальный сервер для мессенджера LIDERS CHAT.

## Что делает

- Регистрация и авторизация пользователей (никнейм + пароль)
- Сигнализация для WebRTC (обмен offer/answer/ICE через HTTP polling)
- Хранение аккаунтов в SQLite (sql.js)
- Офлайн-доставка зашифрованных сообщений (relay)
- Rate limiting, валидация входных данных

## Стек

- Node.js + Express
- sql.js (SQLite на чистом JS, без нативных зависимостей)
- HTTP long-polling вместо WebSocket — работает через DPI/блокировки в РФ

## Деплой (Render.com)

1. Подключи репо в Render → New Web Service
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Plan: Free

Переменные окружения (опционально):
- `DB_PATH` — путь к файлу БД (по умолчанию `/tmp/liders.db`)
- `PORT` — порт (Render задаёт автоматически)

## API

### Аккаунты

```
GET  /check/:username          Проверить свободен ли никнейм
POST /register                 Регистрация {username, password}
POST /login                    Вход {username, password}
POST /guest                    Анонимный вход (без аккаунта)
POST /recover                  Восстановление {username, backupCode, newPassword}
```

### Сигнализация

```
GET  /id                       Получить случайный peer ID (для гостей)
POST /signal                   Отправить сигнал {to, from, data}
GET  /poll/:peerId             Long-poll (держит соединение 20с, возвращает сигналы)
```

### Relay (офлайн доставка)

```
POST /relay                    Сохранить зашифрованные сообщения {to, msgs}
GET  /relay?peer=ID            Получить и удалить очередь сообщений
```

### Мониторинг

```
GET  /health                   Статус сервера
```

## Безопасность

- Пароли: PBKDF2-SHA256, 100 000 итераций, уникальная соль
- Резервный код: PBKDF2-SHA256, 10 000 итераций — хранится только хэш
- Сервер **не видит** содержимое сообщений — только зашифрованные блоки
- Rate limiting: 120 сигналов/мин и 60 polling-запросов/мин с одного IP

## База данных

SQLite сохраняется в `/tmp/liders.db` каждые 60 секунд.  
⚠️ Render Free tier может удалить `/tmp` при пересоздании контейнера.  
Для надёжного хранения — вынести БД на постоянный диск или PostgreSQL.

## Структура аккаунта в БД

```
username      — никнейм в нижнем регистре (он же peer ID)
display_name  — никнейм как ввёл пользователь
password_hash — хэш пароля
salt          — соль пароля
backup_hash   — хэш резервного кода
backup_salt   — соль резервного кода
peer_id       — ID для P2P соединений (= username)
created_at    — timestamp регистрации
```
