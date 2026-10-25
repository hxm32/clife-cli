# clife

A small command line tool for viewing your Caulfield Grammar School timetable from [CaulfieldLife](https://caulfieldlife.com.au).


> **Unofficial.** This project is not affiliated with or endorsed by Caulfield Grammar School or CaulfieldLife. It uses an undocumented API that was found by inspecting network requests, so it may break without notice. Only use it with your own account.

<img width="1167" height="124" alt="image" src="https://github.com/user-attachments/assets/cf427298-3589-498c-959c-c3fc90a40cc1" />
(Teacher names in this image are censored for their privacy. It does not appear this way when actually running it.)

## Features

- View your classes for any date
- Search upcoming classes by subject, class code or teacher
- Token based login with local expiry checks
- Colour coded output that matches your subject colours
- JSON output for scripting
- No dependencies

## Requirements

- Node.js 18 or newer
- A Caulfield Grammar Microsoft account

## Installation

```sh
git clone https://github.com/hxm32/clife
cd clife
sudo npm link
```

`npm link` makes the `clife` command available globally. To uninstall, run `npm unlink -g clife`.

You can also run it directly without installing:

```sh
sudo node clife.js ls
```

## Logging in

CaulfieldLife uses Microsoft SSO, so the CLI cannot log in with a password. Instead you copy the session token from your browser.

1. Log in at [caulfieldlife.com.au](https://caulfieldlife.com.au)
2. Open DevTools and run this in the console:
   ```js
   copy(localStorage.jwt)
   ```
3. Run `clife login` and paste the token when prompted

You can also pass the token another way:

```sh
clife login <token>
pbpaste | clife login -
```

Tokens expire after about an hour. When that happens, repeat the steps above.

## Usage

```
clife login [token]          Save your CaulfieldLife token
clife logout                 Remove the saved token
clife whoami                 Show the logged in user and token expiry
clife token                  Print the saved token
clife ls [date]              Show classes on a date (default: today)
clife search <class name>    Find upcoming classes
```

### Listing classes

```sh
clife ls
clife ls tomorrow
clife ls fri
clife ls 2026-04-13
clife ls 13/4
clife ls +3
```

### Searching

Every word in your query must match the subject name, class code or teacher name.

```sh
clife search software
clife search maths smith
clife search W12SDECA0
clife search english --days 30
clife search english --from monday
```

The API can only be queried by date, so `search` fetches each day in the range and filters the results locally. Larger `--days` values mean more requests.

### Accepted dates

| Input | Meaning |
|---|---|
| `today`, `tomorrow`, `yesterday` | Relative to today |
| `+3`, `-1` | Days from today |
| `mon`, `friday` | The next matching weekday, including today |
| `2026-04-13` | ISO date |
| `13/4`, `13/4/2026` | Day first, year optional |

All dates use Melbourne time, including daylight saving.

### Options

| Option | Description |
|---|---|
| `--json` | Print raw JSON |
| `--no-color` | Disable colours |
| `-d`, `--days <n>` | Days to scan for `search` (default 14, max 120) |
| `--from <date>` | Start date for `search` (default today) |
| `-h`, `--help` | Show help |

### Scripting

```sh
clife ls --json | jq -r '.[].description'
clife search maths --json | jq '.[0]'
```

## Configuration

Your token and member ID are saved to `~/.config/clife/config.json` with `600` permissions. The token is stored in plain text, so treat the file like a password. Run `clife logout` to delete it.

| Variable | Description |
|---|---|
| `CLIFE_CONFIG` | Use a different config file path |
| `XDG_CONFIG_HOME` | Change the base config directory |
| `NO_COLOR` | Disable colours |

## Troubleshooting

**Not logged in** or **Token expired**: run `clife login` with a fresh token.

**Unauthorized**: the token has expired or was copied incorrectly. Make sure you copied the whole value of `localStorage.jwt`.

**No classes**: the timetable only returns results within a valid school timetable period, so weekends, holidays and dates far in the future are empty.

**Network error**: check your connection and that `life-api.caulfieldlife.com.au` is reachable.

## How it works

The CLI talks to the CaulfieldLife GraphQL API at `https://life-api.caulfieldlife.com.au/`. On login it exchanges your Microsoft JWT for a member ID using `GetSessionByJwt`. After that, `ls` and `search` use the `ClassData` query with your Microsoft JWT as the `x-community-token` header.

## License

MIT
