# Chrome Web Store listing

Paste-ready text for the developer dashboard.

## Store listing

**Name:** QA Report for Jira

**Summary (132 characters max):**

File bugs to Jira Cloud with an annotated screenshot, console errors, network log and screen video in one window.

**Category:** Developer Tools

**Language:** English

**Description:**

QA Report turns "it's broken" into a Jira issue someone can act on.

Click the toolbar icon on the page with the bug. QA Report takes a screenshot and collects the console errors the page has logged since it loaded. A window opens where you mark up the screenshot, write the steps, actual and expected result, and pick the project and issue type. Click Create issue and it is in Jira, with everything attached.

What a bug report can include:
- An annotated screenshot (pen, box, arrow)
- Console errors and failed resource loads, including from iframes
- A list of recent network requests, or a full HAR recording while you reproduce the bug
- Screen video clips, cropped to the area that matters, shown inline in the issue
- Screenshots pasted straight into the steps or results
- The page URL, browser and viewport size

It fits your Jira: projects, issue types, priorities and every required field come from your own Jira configuration, and the optional fields you pick are remembered per project.

It also posts test reports: a comment on an issue with the result, your fields and evidence files. Your team defines the template (heading, result options, fields) once and shares it as a settings file.

Fill with AI writes the report for you: it reads the issue description and comments and fills what was checked and how, using Claude Code or Codex already installed on your computer. It runs on your own Claude or ChatGPT plan, no API key. Optional, with a one-time setup command the extension shows you (Windows, macOS and Linux).

Private by design: your API token stays in your browser and is sent only to your Jira site. No server, no analytics, no tracking.

Works with Jira Cloud (atlassian.net). Needs an Atlassian API token.

QA Report is not affiliated with or endorsed by Atlassian. Jira is a trademark of Atlassian.

## Privacy practices tab

**Single purpose:** Capture evidence of a software bug on the current page and file it to the user's own Jira Cloud site.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user's Jira site, email and API token locally, plus preferences and the current bug draft. |
| `webRequest` | Keeps a short in-memory list of the tab's recent requests (method, status, URL) for the bug report, and reads the redirect target of a Jira attachment to show uploaded images and videos inline in the issue. Requests are observed only, never blocked or changed. |
| `debugger` | Records the full network traffic of one tab as a HAR file, only when the user ticks "Record network traffic", until the issue is created. |
| Host permission `<all_urls>` | The content script captures console errors on any page the user may need to report a bug from, from the moment the page loads, which is before the user knows there is a bug. The extension also calls the Jira site the user entered, which can be any Jira Cloud address. |
| `nativeMessaging` (optional) | Requested only when the user clicks "Fill with AI" in a test report. Passes the issue text to the Claude Code or Codex command-line tool the user installed on their own computer, through a bridge script the user installs themselves, and gets back the filled report text. |
| Remote code | No. All code ships in the package. The native bridge is a separate program the user installs; the extension only sends it text and reads text back. |

**Data usage (tick these):**

- Authentication information: the Jira API token, stored locally, sent only to the user's Jira site.
- Website content: screenshots, console messages and network data of the page the user reports, sent only to the user's Jira site when they create an issue.
- Personally identifiable information: the user's email, sent only to their Jira site to sign in.
- Website content also covers Fill with AI: the issue description and comments, passed on click to the AI command-line tool on the user's own computer, which sends them to Anthropic or OpenAI under the user's own account.

Certify: not sold to third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

**Privacy policy URL:** https://github.com/stokrattt/qa-report-for-jira/blob/main/PRIVACY.md

**Support email:** stokratt@gmail.com

## Images to upload

All ready in `docs/store/`, at the exact sizes the store accepts.

| Asset | Size | File |
| --- | --- | --- |
| Store icon | 128 x 128 | `icons/icon-128.png` |
| Screenshot 1 | 1280 x 800 | `docs/store/screenshot-1-capture-dark.png` |
| Screenshot 2 | 1280 x 800 | `docs/store/screenshot-2-report-dark.png` |
| Screenshot 3 | 1280 x 800 | `docs/store/screenshot-3-template-editor.png` |
| Screenshot 4 | 1280 x 800 | `docs/store/screenshot-4-capture-light.png` |
| Small promo tile | 440 x 280 | `docs/store/promo-small-440x280.png` |

## Before you submit

1. Bump `version` in `manifest.json` for every upload.
2. Run `npm test`, then `npm run zip`, and upload `qa-report-for-jira.zip`.
3. Expect a longer review: `debugger` and `<all_urls>` trigger manual review. The justifications above answer what reviewers ask.
