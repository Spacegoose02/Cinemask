# Home Assistant

Cinemask works with Home Assistant in two directions, with nothing to install:

- **Sensors:** Home Assistant reads `/api/stats` with an API key.
- **Events:** Cinemask calls a Home Assistant webhook when something happens (a request, a finished download, a failure).

## 1. Create an API key

Sign in as the person Home Assistant should act as (an admin, if you want the health sensor), open **Account → API keys**, name it "Home Assistant", choose **Read-only**, and copy the key. Put it in `secrets.yaml`:

```yaml
cinemask_api_key: cmk_...
```

## 2. Sensors

```yaml
# configuration.yaml
rest:
  - resource: http://cinemask:7979/api/stats
    headers:
      X-Api-Key: !secret cinemask_api_key
    scan_interval: 300
    sensor:
      - name: Cinemask pending requests
        unique_id: cinemask_requests_pending
        value_template: "{{ value_json.requests.pending }}"
        icon: mdi:movie-open-plus
      - name: Cinemask active downloads
        unique_id: cinemask_downloads_active
        value_template: "{{ value_json.downloads.active }}"
        icon: mdi:download
      - name: Cinemask movies
        unique_id: cinemask_movies
        value_template: "{{ value_json.library.movies }}"
        icon: mdi:filmstrip
      - name: Cinemask shows
        unique_id: cinemask_shows
        value_template: "{{ value_json.library.shows }}"
        icon: mdi:television-classic
      - name: Cinemask releases this week
        unique_id: cinemask_upcoming_week
        value_template: "{{ value_json.upcoming.week }}"
        icon: mdi:calendar-star
      - name: Cinemask book requests
        unique_id: cinemask_books_pending
        value_template: "{{ value_json.books.pending }}"
        icon: mdi:book-open-variant
    binary_sensor:
      - name: Cinemask needs attention
        unique_id: cinemask_health
        device_class: problem
        # Only an admin's key gets health; for others this stays off.
        value_template: "{{ value_json.health is not none and value_json.health.level not in [none, 'ok'] }}"
```

What `/api/stats` returns:

```json
{
  "library": { "movies": 812, "shows": 96 },
  "monitored": 140,
  "requests": { "pending": 2, "approved": 5, "available": 61 },
  "books": { "pending": 1, "downloading": 0 },
  "downloads": { "active": 3, "failed24h": 0 },
  "upcoming": { "today": 1, "week": 6 },
  "health": { "level": "ok", "problems": 0, "checkedAt": 1760000000000 }
}
```

## 3. Events from Cinemask

1. In Home Assistant, create an automation with a **Webhook** trigger. Note its webhook id, for example `cinemask-events`, and leave **Only accessible from the local network** on if Cinemask is on your LAN.
2. In Cinemask, open **Settings → API and webhooks**, tick **Send webhook events**, set the URL to `http://homeassistant.local:8123/api/webhook/cinemask-events`, choose the events, and press **Save and send a test**.

Each event is a JSON POST:

```json
{
  "source": "cinemask",
  "event": "request.available",
  "title": "Request ready",
  "message": "Paddington (2014) is ready to watch",
  "data": { "kind": "movie", "tmdbId": 116149, "requestId": 12, "requestedBy": "kid" },
  "at": "2026-10-20T18:04:11.000Z"
}
```

Events: `request.created`, `request.available`, `download.imported`, `download.failed`, `download.warning` (grabbed although bigger than the size limit), `health.problem`.

An automation that sends a phone notification:

```yaml
automation:
  - alias: Cinemask notifications
    triggers:
      - trigger: webhook
        webhook_id: cinemask-events
        allowed_methods: [POST]
        local_only: true
    actions:
      - action: notify.mobile_app_your_phone
        data:
          title: "{{ trigger.json.title }}"
          message: "{{ trigger.json.message }}"
```

Or dim the lights when something new is ready for movie night:

```yaml
    conditions:
      - condition: template
        value_template: "{{ trigger.json.event == 'request.available' }}"
```

## Security notes

- Use a **read-only** key for sensors. It can't change anything even if Home Assistant is compromised.
- The webhook URL is stored encrypted and never shown again, because the id in it is what lets anyone call it.
- Keys can't reach settings, users, backups or other keys, whatever role their owner has.
