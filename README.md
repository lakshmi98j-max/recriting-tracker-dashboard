# Recruiting tracker dashboard

The public, data-free front end for the private repo `lakshmi98j-max/recriting-tracker-2`.

This repo holds only `index.html` and `assets/`. It contains no contacts, no todos, no mail. When you open the page and click Connect GitHub with a fine-grained token (Contents: Read and write on the private data repo), the page reads `data/contacts.json` and `data/todos.json` through the GitHub API from your browser, and the Mark done / Reopen buttons commit back to that repo. Without a token the page shows a connect prompt and nothing else.

Hosted with GitHub Pages: Settings, Pages, Deploy from a branch, `main`, `/ (root)`.

The source of truth for these two files is the private repo; copy changes here when they change there.
