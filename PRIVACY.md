# Privacy policy for QA Report for Jira

Last updated: 12 November 2026

QA Report for Jira ("QA Report") is a Chrome extension that creates Jira issues and comments on your behalf. This page says what it handles and where that goes.

## What QA Report stores

In your browser profile only:

- Your Jira site address, Atlassian email and API token, in `chrome.storage.local`. They are not synced to other devices.
- Your preferences (theme, last project and issue type, default labels, the test report template, field values you picked under More fields, checkbox states), in `chrome.storage.sync`, which Chrome syncs between your own signed-in browsers.
- The current bug draft (screenshot, logs) in `chrome.storage.session`, cleared when the browser closes or the issue is created.
- The current test report draft text, in `chrome.storage.local`, cleared when the comment is posted.

## What QA Report reads

- **Console errors and failed resource loads** on the pages you visit, kept in memory per tab (the last 50), so a bug report can include what happened before you clicked.
- **Network request summaries** (method, status, URL) per tab, kept in memory (the last 50).
- **Full network traffic** of one tab, only when you tick "Record network traffic" and only until you create the issue or close the capture window.
- **A screenshot** of the visible tab, only when you click "Capture bug".
- **Screen video**, only when you start a recording and choose what to share in Chrome's own picker.

In-memory data is dropped when the tab closes or the extension restarts.

## Where data goes

Data goes to one place: the Jira Cloud site you entered, through Atlassian's REST API, when you click "Create issue" or "Post comment". QA Report sends nothing to its authors or to any third party. It has no server, no analytics, no ads and no tracking. Atlassian handles the data you send to your Jira site under your organisation's agreement with Atlassian.

Review the screenshot, logs and HAR before you create an issue: they can contain whatever the page showed or sent, including personal data or session tokens. You can remove the screenshot, and you can leave network recording off.

## Removing your data

Click **Disconnect** in QA Report's settings to delete the stored token, or remove the extension to delete everything it stored.

## Contact

Questions about this policy: stokratt@gmail.com
