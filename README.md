# SecureGram — Signal Server

Сигнальный сервер для P2P мессенджера SecureGram.  
Используется **только** для установки начального WebRTC соединения.  
Сообщения через него **не проходят** — они идут P2P напрямую между браузерами.

## Деплой на Railway (5 минут)

1. Форкни или загрузи этот репозиторий на GitHub
2. Зайди на [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Выбери этот репозиторий
4. Railway автоматически запустит сервер
5. Зайди в Settings → Networking → Generate Domain
6. Скопируй домен — он вида `xxx.up.railway.app`

## Проверка

```
https://ВАШ-ДОМЕН.up.railway.app/health
```

Должен вернуть `{"ok":true,...}`

## Переменные окружения (опционально)

| Переменная | Описание |
|---|---|
| `PORT` | Порт (Railway выставляет автоматически) |

## Стек

- Node.js 20
- [PeerJS Server](https://github.com/peers/peerjs-server)
