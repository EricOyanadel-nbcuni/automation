# Automation Repo Prompt

Use this prompt when making changes in this repository.

## Context
- This repository contains Tampermonkey UserScripts and generated output files.
- Primary scripts include standup and Jira reporting workflows.

## Rules
1. Preserve existing behavior unless the request explicitly asks to change it.
2. Keep edits small and targeted; avoid broad refactors.
3. Maintain compatibility with Tampermonkey and Jira Cloud pages.
4. Prefer clear, defensive error handling for network and file APIs.
5. Do not remove existing persistence behavior (IndexedDB / file handle flow) unless requested.
6. Keep output text formatting stable unless explicitly requested.
7. Every UserScript metadata header at the top of each `.user.js` file must include a last-modified date field.

## Required Metadata Rule
- Add this field inside the UserScript header block when creating or modifying a script:

```javascript
// @lastModified 2026-08-14
```

- Format must be `YYYY-MM-DD`.
- Update the date whenever the script is modified.

## Validation Checklist
- Script still injects and runs on Jira pages.
- No syntax errors introduced.
- User-visible text changes match the request exactly.
- `@lastModified` exists and is current in edited `.user.js` files.
