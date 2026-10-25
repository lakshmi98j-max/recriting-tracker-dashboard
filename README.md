# Recruiting Tracker

A job-search CRM that an AI agent keeps up to date. The agent runs on my laptop, reads my recruiting email, and maintains the contact and task data. I make the decisions and send every email myself. This page is the dashboard.

Two different uses of AI are in play, and they are worth separating:

- **Built with AI.** The tool was designed and written in pair-programming sessions with Claude Code, Anthropic's coding agent, over about a month, iterating on real mail.
- **Run by an AI agent.** The same Claude Code runs locally on my Mac as an agent, not as a chat window. It follows a written routine and a rulebook that live in the repo, and every change it makes to the data is a git commit under its own label. That is what updates the numbers on this dashboard.

This repo is the public, data-free half: the dashboard page. The data lives in a private repo. The split is explained below.

Live page: https://lakshmi98j-max.github.io/recriting-tracker-dashboard/ (it needs a GitHub token to the private data repo, so a visitor without one sees only the connect screen).

## The problem

A job search is dozens of email threads at once: recruiters, coffee chats, referrals, application receipts, mock interviews. The failure mode is quiet. Someone replies, the thread slips below the fold, and a week later I have lost the follow-up. A spreadsheet needs me to remember to update it, which is the same problem one step removed. I wanted something that updates itself from the inbox and tells me each morning what I owe people, without paying for a CRM or handing my mailbox to a third party.

## What the dashboard does

- Four tiles: open todos, high priority, follow-ups needed, awaiting my reply. Each one filters the lists below.
- A todo list with status and priority filters. Mark done and Reopen commit the change straight to the data repo.
- A people table: stage, last touch, next action, and a link that opens the exact Gmail thread. Search and stage filters.
- A details row per person: the last message in the thread, a draft reply I can copy into Gmail, a "respond on" date that snoozes the person, and my own notes.
- Close and Reopen people. Nothing is ever deleted.
- Plain HTML, CSS and JavaScript. No framework, no build step, no analytics. Dark mode follows the system.

## How the agent runs

Each run starts with me opening Claude Code in the private repo on my laptop and typing `/daily`. From there the agent works through a fixed routine:

1. Pulls the latest data, so changes I made from this page are included.
2. Runs the mail sync, which pulls the last 14 days of mail over IMAP into a temporary file.
3. Triages only the threads that are new or have new messages since the last run, using the rulebook: which emails count as recruiting or networking mail, which are newsletters and receipts, who the people are, who wrote last and when.
4. Creates or updates contacts and todos, derives each person's stage, sets priorities, records the last message, and writes a draft reply where I owe the next move.
5. Runs the validator on both data files, commits with the label `daily:`, and pushes.
6. Deletes the raw mail pull, prints a summary of what is high priority, who needs a follow-up and who replied, and lists any thread it was not sure about under "Ask me" for me to decide.

The human stays in the loop on purpose. I start every run, approve each command the agent runs, answer its "Ask me" list, and send every email myself from Gmail. The agent has read-only access to the mailbox and never sends, replies, labels or deletes anything there.

## How it works

- **Data**: `contacts.json` and `todos.json` in a private git repo are the database. Every change is a commit, so the history is the audit log and nothing can be lost.
- **Mail**: a Python script pulls the last 14 days of mail over IMAP, groups messages by thread, strips quoted replies and signatures, and writes a temporary file that is deleted after every run. Nothing from the mailbox is kept on disk.
- **Agent**: Claude Code runs the routine above under a 226-line rulebook: which emails count, how a contact's stage follows from who wrote last and when, how priority is assigned, how a draft reply is written, and the hard rules. Never delete, never send or change anything in Gmail, never invent a person, date or fact, never touch the owner's own notes. When it is unsure whether an email is recruiting mail it asks instead of guessing.
- **Validator**: a script checks both data files for schema, ids, dates and consistency before every commit, and a GitHub Action runs it on every push.
- **Dashboard**: this page reads the private data through the GitHub API with a fine-grained token stored only in my browser, and its buttons write back as commits. Changes made from the page and changes made by the agent land in the same history, each under its own label, so the log shows who did what.

## Why the data is private

The data files hold the names, email addresses, message excerpts and draft replies of real people: recruiters, alumni, hiring managers. That is not mine to publish. So the code and the page are public here, and the data stays private there. A visitor can see exactly how the system works without seeing anyone's mail.

## By the numbers

As of 25 October 2026:

- 1,702 email threads screened by the agent
- 46 contacts and 26 todos tracked
- 50 commits on the private data repo in the first month: 7 runs by the agent (labelled `daily:`), 38 one-click updates by me from this page (labelled `update: ... (dashboard)`), 5 tooling changes
- about 3,100 lines of code and rules: 590 for the mail sync, 344 for the validator, 1,900 for the dashboard, 290 of agent rules and routine
- $0 a month: GitHub Pages, the GitHub API and Gmail IMAP are free, and the agent runs under a Claude Code plan I already had

## How it evolved

1. **Version one in a day.** A written spec: the data schema, the rules for stage and priority, the sync script, the validator, the dashboard and the daily routine. The first real run turned the inbox into 14 contacts and 8 todos.
2. **"I marked it done and it came back."** The page was read-only. Added Mark done and Reopen that commit through the GitHub API, then fixed the stale cache by reading live from the API and versioning the assets.
3. **Wrong mailbox.** The first run through a Gmail connector read an account that was not mine. The data was wiped and a rule was added: the tracked mailbox is the one named in the private configuration, never an account assumed from a connector or a signature.
4. **Links that opened the wrong Google account.** Thread links now carry the mailbox address, so they open the right account whatever else is signed in.
5. **Going private.** A credential landed in a commit through the GitHub web editor. I revoked it, rewrote the history, made the data repo private, and split the dashboard into this public repo that reads the data through the API. The architecture is better for it.
6. **Context on the page.** Each person got the last message in the thread and a ready-to-send draft reply with a Copy button, plus a Close button so I decide who stays active.
7. **My notes outrank the agent.** A "respond on" date and append-only owner notes per person. The agent reads them before it triages or drafts, and may never edit or remove them. The design question was how to keep human input safe from automation; the answer was fields the automation is forbidden to write.
8. **Automation, then a decision.** Scheduled cloud runs could not reach IMAP and could not carry the mail connector. A laptop schedule got as far as launching the agent, but a managed Claude Code policy on my account requires a person to approve each command, so an unattended run cannot finish. I chose to run the agent by hand and keep the schedule documented as optional, rather than work around a control I did not set.

## What I took from it

- Plain files in git beat a database for a one-person tool: diffable, revertible, hostable for free.
- An agent needs a rulebook more than it needs capabilities. Most of the design effort went into the rules, not the code.
- Decide early which fields belong to the human. Everything the automation may never write is what makes it trustworthy.
- Privacy decides architecture. The public and private split came from the data, not from a preference.

## Built with

Claude Code, Python 3 standard library (imaplib, email, json), vanilla JavaScript and CSS, GitHub Pages, GitHub API and GitHub Actions.

## Repo notes

This repo holds only `index.html`, `assets/` and this file. It contains no contacts, no todos and no mail. The page is hosted with GitHub Pages from the `main` branch. The source of truth for the page files is the private repo `lakshmi98j-max/recriting-tracker-2`; changes are copied here when they change there.
