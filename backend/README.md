# AwaazForm Backend

FastAPI + SQLite + SQLAlchemy + Pydantic. Handles answer validation, form parsing (pasted text, .txt, PDF) and optional progress saving.

## Run

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # Windows: copy .env.example .env
uvicorn app.main:app --reload --port 8001
```

Interactive docs: http://localhost:8001/docs

## Test

```bash
python -m pytest -q
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/forms` | List sample forms |
| GET | `/api/forms/{id}` | One sample form (`scholar`, `camp`) |
| POST | `/api/validate` | Body `{field, raw}` -> `{valid, value, err}` |
| POST | `/api/parse/text` | Body `{text}` -> fields (unclear ones flagged) |
| POST | `/api/parse/file` | Multipart `file` (.txt or .pdf) -> fields |
| POST | `/api/parse/url` | Body `{url}` -> the questions found on a public form link (Google Forms or ordinary HTML forms) |
| POST | `/api/extract/text` | Multipart `file` (.txt or .pdf) -> `{text}` (used by the frontend upload) |
| POST | `/api/sessions` | Save progress (optional, user-initiated) |
| GET | `/api/sessions/{id}` | Load saved progress |
| DELETE | `/api/sessions/{id}` | Delete saved progress |

## Privacy

- Sensitive answers (Aadhaar, PAN etc.) are never stored.
- Saved progress expires after 24 hours (`SESSION_TTL_HOURS`).
- Audio is never received or stored.
- The server never submits any form.

## Reading a form link

`POST /api/parse/url` visits a public https link and returns its questions in the same shape as `/api/parse/text`.

- **Google Forms** (including `forms.gle` short links): read from the page's embedded data.
- **Ordinary HTML forms**: inputs, dropdowns, radio groups and text areas, with their labels.
- **Flagged, not guessed**: checkboxes, file uploads, grids and time fields are returned with `flag: true`.
- **Cannot read**: forms that need a sign-in, or pages that build their questions with JavaScript (for example Microsoft Forms). The API answers with a `code` (`needs_signin`, `no_questions`, `fetch_failed`, `blocked`, `too_large`, `not_html`) and the app asks the user to paste the questions instead.
- **Safety**: the server only visits public https addresses on port 443. Localhost, private networks and cloud metadata addresses are refused, redirects are re-checked at every step, and downloads are capped at 2 MB and 10 seconds.
- **Privacy**: only the link is received, never answers. Links are not stored or logged by the app.

### Filling the real form (Google Forms)

The reader keeps each question's Google field id (`source_key`, like `entry.123456`) and returns the form's final address (`source_url`).
At the end of the guided flow, the frontend builds a pre-filled link from those ids and opens it, so the real form appears with the confirmed answers in it.
The user presses Submit themselves; nothing is ever submitted for them.
The link is built in the browser, so answers never pass through this server.
Private answers (Aadhaar, PAN) are left out of the link because links stay in browser history.
Grids, file uploads and time questions cannot be pre-filled and are left for the user.
Ordinary HTML forms cannot be pre-filled this way; they need the planned browser extension.

Google can change the data format of its forms without notice. If a Google Form stops being read, `extract_google_form` in `app/urlforms.py` is the place to look.

## Frontend connection

`js/api.js` in the frontend calls this server and falls back to on-device logic when it is off.
Used now: `/api/health`, `/api/parse/text`, `/api/parse/url`, `/api/extract/text`.
Not used by default: `/api/validate` (switch `SERVER_VALIDATION` in `js/api.js`) and `/api/sessions`,
because the app promises that answers stay on the device.

## Calling it directly

```js
const API = 'http://localhost:8001/api';

const res = await fetch(`${API}/validate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ field, raw: answerText }),
});
const { valid, value, err } = await res.json();
```

`err` is an i18n key the frontend already has (`errPhone`, `errDate`, ...).
