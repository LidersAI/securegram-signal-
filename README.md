<div align="center">

# 𝕃 LIDERS CHAT — Signal Server

### HTTP Long-Polling · PostgreSQL · Relay

[![Render](https://img.shields.io/badge/Render-Live-46E3B7?style=for-the-badge&logo=render)](https://liders-chat-signal.onrender.com/health)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=for-the-badge&logo=supabase)](https://supabase.com)
[![Node](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs)](https://nodejs.org)

</div>

---

## 📡 Назначение

Минимальный сигнальный сервер для WebRTC handshake. Участвует **~0.2 секунды** при установке соединения. После этого весь трафик идёт P2P напрямую между устройствами.

Дополнительно хранит зашифрованные сообщения для офлайн-доставки (relay) до 7 дней.

---

## 🔌 API

### Аккаунты
| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/check/:username` | — | `{taken}` |
| `POST` | `/register` | `{username, password}` | `{ok, token, peerId, username, backupCode}` |
| `POST` | `/login` | `{username, password}` | `{ok, token, peerId, username}` |
| `POST` | `/guest` | — | `{ok, peerId}` |
| `POST` | `/recover` | `{username, backupCode, newPassword}` | `{ok, token, ...newBackupCode}` |

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
| Метод | Путь | Ответ |
|---|---|---|
| `GET` | `/health` | `{ok, accounts, online, queued}` |

---

## 🔐 Безопасность

- **Пароли:** PBKDF2-SHA256, 100 000 итераций, уникальная соль
- **Резервный код:** PBKDF2-SHA256, хранится только хэш
- **Сессии:** 64 hex-символа, срок 30 дней
- **Rate limiting:** 120 сигналов/мин, 60 polling/мин с IP
- **SSL:** принудительный для Supabase

---

## 🗄 База данных (Supabase PostgreSQL)

```sql
accounts: username, display_name, password_hash, salt,
          backup_hash, backup_salt, peer_id, created_at

sessions: token, username, peer_id, expires_at
```

---

## 📦 Стек

```
Node.js 18+ · Express 4 · pg (node-postgres) · Supabase
```

---

## 🚀 Деплой на Render

1. New Web Service → GitHub репо
2. Build: `npm install` · Start: `npm start`
3. Environment variable:
```
DATABASE_URL=postgresql://postgres:...@db.xxx.supabase.co:5432/postgres
```

**Важно:** подключи UptimeRobot на `https://liders-chat-signal.onrender.com/health` каждые 5 минут — иначе Render засыпает и соединения рвутся.

---

## 📊 Мониторинг

```bash
curl https://liders-chat-signal.onrender.com/health
# {"ok":true,"service":"LIDERS CHAT","accounts":5,"online":2,"queued":0}
```

---

<div align="center">

**© 2026 LIDERS CHAT** · [liderschat.online](https://liderschat.online)

</div>
