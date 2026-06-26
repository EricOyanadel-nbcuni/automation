# NBC Automation

Tampermonkey userscripts and reporting tools for Jira workflow automation.

## Scripts

- **jira-standup.user.js** — Generates a daily standup message from your active sprint tickets, copies it to clipboard, and saves a JSON snapshot to `standup_data/`
- **jira-epic-report.user.js** — Generates a markdown epic progress report saved to `epic_reports/`
- **jira-copilot.user.js** — Jira + GitHub Copilot integration utilities

## Reports

- **standup-report.html** — Visual dashboard built from the `standup_data/` snapshots (open locally in browser)

## Data

- `standup_data/` — Daily JSON snapshots of your sprint tickets, one file per working day
- `epic_reports/` — Generated epic reports in markdown format

## Setup

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Add each `.user.js` script to Tampermonkey via **Dashboard → + (New Script)**, paste the file contents, and save
3. Create the following output folders on your machine before running the scripts:
   - `/standup_data/`
   - `/epic_reports/`
4. On first run, each script will prompt you to select its output folder — navigate to the paths above

> **Note:** `standup_data/` and `epic_reports/` are excluded from version control via `.gitignore`.
