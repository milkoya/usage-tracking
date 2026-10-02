# 📊 Usage Tracking

A side panel that shows what your Claude Code usage costs, day by day and week by week.

```
/usage-tracking
```

Or just `/ut`. Both open right away, even while Claude is in the middle of a reply.

## What's in the panel

- **Today, this week and the last 30 days**: cost and tokens, plus when your 7-day limit resets
- **Cost per day** and **tokens per day** for the last 30 days
- **Cost per week** and **tokens per week** for the last 8 weeks
- **Weeks**: a list of the last 8 weeks with their cost and tokens. Press **1–8** to open one
- **The week you picked**: cost per day and tokens per day, cost by model, and tokens by type (input, output, cache write, cache read)

Hover any bar to see its exact cost and tokens.

Weeks line up with your 7-day usage limit, so "this week" means the same thing as the `7d` bar. Without a subscription limit, weeks start on Monday.

**Keys:** with the panel focused, **1–8** pick a week, the **arrow keys** scroll and **Esc** closes it.

## How it works

Claude Code keeps a log of every conversation in `~/.claude/projects`. The panel adds up the token counts in those logs and prices them at Anthropic's API list prices, so the dollar figures are **estimates** of what the same usage would cost on the API.

It's built to stay light:

- **The first time**, it reads all your logs once in the background. That takes a few seconds to about half a minute, depending on how much you've used Claude Code.
- **After that**, it only reads what's new at the end of each log, usually nothing or a few kilobytes.
- **It only works while the panel is open**: once when you open it, then once a minute. Closed, it does nothing.
- **Its notes are small**: hourly totals per model for the last two months and daily totals before that, kept by Claude Code in the plugin's store (a few hundred KB at most). If Claude Code cleans up old logs, the totals already counted stay, for about 400 days.
- **If a log can't be read**, the panel says so and tries that log again on the next refresh, so nothing is skipped for good.

Each reply is counted once, even though the logs often write the same reply several times. Advisor calls inside a reply are counted too, on their own model.

**Why it can be lower than Claude Code's own session cost:** Claude Code also pays for a few calls it never writes to the logs, like compacting a long conversation. The panel can only count what's in the logs.

## Privacy

- **Nothing leaves your computer.** No network requests at all.
- **It reads only token counts, model names and times** from your logs, never what you or Claude wrote.

## Install

Clone this repo into `~/.claude/mods/usage-tracking`:

```sh
git clone https://github.com/milkoya/usage-tracking.git ~/.claude/mods/usage-tracking
```

Then either run `claude --plugin-dir ~/.claude/mods`, or add this to `~/.claude/settings.json` so it loads every time:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods"
  }
}
```

Start a new Claude Code session and run `/usage-tracking`.

Usage Tracking is built on Claude Code's **function hooks**, an early-access feature that's still rolling out. If your Claude Code doesn't load it yet, it will once the feature reaches you.

## Tinkering

| File | What's inside |
| --- | --- |
| `hooks/scan.ts` | The small shell script that pulls token counts out of the logs (`dd`, `grep` and `awk`) and the reader for its output |
| `hooks/ledger.ts` | Hourly totals, where each log was read up to, and counting each reply once |
| `hooks/prices.ts` | API list prices per model |
| `hooks/report.ts` | Totals, daily and weekly series, and lining weeks up with the 7-day reset |
| `hooks/chart.ts` | The bar charts |
| `hooks/format.ts` | Money, token counts, dates and model names |
| `hooks/register.tsx` | The command, the panel and when to read the logs |

Check your changes with:

```sh
claude plugin validate .
claude plugin test .
node --experimental-strip-types tests/scan-check.mts
```

The last one runs the real log reader against a sample log, which `claude plugin test` can't do.

## License

MIT © Mio
