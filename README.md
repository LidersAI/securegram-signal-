<div align="center">

# 𝕃 LIDERS CHAT — Signal Server

### HTTP Long-Polling Сигнальный Сервер

[![Deploy](https://img.shields.io/badge/Render-Live-46E3B7?style=for-the-badge&logo=render&logoColor=white)](https://liders-chat-signal.onrender.com/health)
[![DB](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](#)
[![Node](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#)

</div>

---

## 📡 Что делает

Минимальный сервер для «знакомства» устройств. Участвует **только** при установке P2P соединения — меньше секунды. После этого весь трафик идёт напрямую между устройствами.

**Сервер никогда не видит содержимое сообщений** — только зашифрованные блоки для офлайн-доставки.

---

## 🔌 API

### Аккаунты

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/check/:username` | Проверить занят ли никнейм |
| `POST` | `/register` | Регистрация `{username, password}` |
| `POST` | `/login` | Вход `{username, password}` |
| `POST` | `/guest` | Анонимный вход |
| `POST` | `/recover` | Восстановление `{username, backupCode, newPassword}` |

### Сигнализация (WebRTC)

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/id` | Получить случайный peer ID |
| `POST` | `/signal` | Отправить сигнал `{to, from, data}` |
| `GET` | `/poll/:peerId` | Long-poll 20с — ждёт входящие сигналы |

### Relay (офлайн-доставка)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/relay` | Сохранить зашифрованные сообщения `{to, msgs}` |
| `GET` | `/relay?peer=ID` | Забрать и удалить очередь |

### Мониторинг

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Статус: аккаунты, онлайн, очередь |

---

## 🔐 Безопасность

- **Пароли:** PBKDF2-SHA256, 100 000 итераций, уникальная соль
- **Резервный код:** PBKDF2-SHA256, хранится только хэш, никогда в открытом виде
- **Сессии:** токены 64 hex-символа, срок 30 дней
- **Rate limiting:** 120 сигналов/мин и 60 polling/мин с одного IP
- **Валидация:** peerId только `[a-zA-Z0-9_-]`, не более 64 символов

---

## 🗄 База данных

**Supabase PostgreSQL** — аккаунты хранятся постоянно, переживают рестарты.

```sql
CREATE TABLE accounts (
  username      TEXT PRIMARY KEY,       -- никнейм (lowercase)
  display_name  TEXT NOT NULL,          -- как ввёл пользователь
  password_hash TEXT NOT NULL,          -- PBKDF2 хэш
  salt          TEXT NOT NULL,
  backup_hash   TEXT NOT NULL,          -- хэш резервного кода
  backup_salt   TEXT NOT NULL,
  peer_id       TEXT NOT NULL UNIQUE,   -- = username
  created_at    BIGINT NOT NULL
);
```

---

## 📦 Стек

```
Node.js 18+ + Express 4
PostgreSQL (Supabase)
pg (node-postgres)
```

---

## 🚀 Деплой на Render

1. Подключи репо → **New Web Service**
2. Build: `npm install`
3. Start: `npm start`

**Переменная окружения:**
```
DATABASE_URL = postgresql://postgres:...@db.xxx.supabase.co:5432/postgres
```

---

## 📊 Мониторинг

```bash
curl https://liders-chat-signal.onrender.com/health
# {"ok":true,"service":"LIDERS CHAT","accounts":42,"online":3,"queued":0}
```

---

<div align="center">

**© 2026 LIDERS CHAT** · [liderschat.online](https://liderschat.online)

</div>
