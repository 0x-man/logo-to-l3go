# Put Logo to Bricks online, step by step

About 30–45 minutes the first time. Free on both services. No coding needed, just careful copy-pasting.

You'll set up two things:

| Piece | What it does | Where it lives | Cost |
|---|---|---|---|
| **The site** | Everything you see: reading logos, the 3D sign, instructions, parts lists | GitHub Pages | Free |
| **The logo finder** | Opens a website and picks out its logo (browsers aren't allowed to do this themselves) | Cloudflare Workers | Free plan: 100,000 requests a day |

The site works without the logo finder (file upload only), so if part 2 gives you trouble, part 1 still gets you a working site.

---

## What you need

- A **GitHub** account: https://github.com/signup
- A **Cloudflare** account: https://dash.cloudflare.com/sign-up
- **GitHub Desktop** (the easiest way to upload a folder with hidden files in it): https://desktop.github.com/download/
- The `logo-to-bricks` folder, unzipped somewhere you can find it (e.g. your Documents folder)

> ⚠️ **Hidden folder alert.** The project has a folder called `.github` (with a dot) that tells GitHub how to build the site. Finder and Explorer hide dot-folders, and dragging files into github.com in your browser can silently skip them. GitHub Desktop doesn't. That's why step 1 uses it.

---

## Part 1 — Put the code on GitHub

1. Open **GitHub Desktop** and sign in with your GitHub account.
2. **File → Add Local Repository…** → choose the `logo-to-bricks` folder.
3. It says "this directory does not appear to be a Git repository". Click **create a repository** in that message.
   - Name: `logo-to-bricks`
   - Leave the rest as is → **Create Repository**.
4. Click **Publish repository** (top bar).
   - Keep the name `logo-to-bricks`.
   - **Keep this code private**: your choice. Public is fine (nothing secret is in it). GitHub Pages on a private repo needs a paid plan, so untick it if you're on the free plan.
   - Click **Publish Repository**.
5. Check: go to `https://github.com/YOUR-GITHUB-NAME/logo-to-l3go`. You should see the files, including a `.github` folder.

## Part 2 — Tell the logo finder which site it serves

The logo finder refuses requests from any site not on its list. Before deploying it, put your future site address on that list.

1. Your site address will be `https://YOUR-GITHUB-NAME.github.io` (all lowercase, no slash at the end).
2. On github.com, open your repository → folder `logo-api` → file `wrangler.toml` → click the ✏️ pencil (Edit).
3. Find this line:
   ```toml
   ALLOWED_ORIGINS = "https://YOUR-GITHUB-NAME.github.io,http://localhost:5173"
   ```
   Replace `YOUR-GITHUB-NAME` with your GitHub user name. Example for user `jane-doe`:
   ```toml
   ALLOWED_ORIGINS = "https://jane-doe.github.io,http://localhost:5173"
   ```
   (`http://localhost:5173` is only for testing on your own computer. Remove it once everything works: see Part 6.)
4. Click **Commit changes…** → **Commit changes**.
5. In GitHub Desktop, click **Fetch origin** then **Pull origin** so your computer has the same change.

## Part 3 — Deploy the logo finder on Cloudflare

1. Log in at https://dash.cloudflare.com.
2. Left menu: **Compute (Workers)** or **Workers & Pages** (the name varies) → **Create application**.
3. Next to **Import a repository**, click **Get started**.
4. Connect your GitHub account when asked, and allow access to the `logo-to-bricks` repository only (safer than "all repositories").
5. Pick `logo-to-bricks` from the list. On the settings screen:
   - **Project name / Worker name**: `logo-to-bricks-api` ← must be exactly this: it has to match `name` in `wrangler.toml` or the build fails.
   - **Root directory** (under advanced/build settings): `logo-api`
   - **Build command**: leave empty.
   - **Deploy command**: leave the default `npx wrangler deploy`.
6. Click **Save and Deploy**. Wait for the green "Success" (about a minute).
7. Copy your logo finder's address. It looks like:
   ```
   https://logo-to-bricks-api.YOUR-CLOUDFLARE-SUBDOMAIN.workers.dev
   ```
   You'll find it on the Worker's page (**Settings → Domains & Routes**, or the "Visit" link).
8. Quick test: open that address followed by `/find?site=example.com` in your browser. You should see:
   ```json
   {"error":"This logo finder only answers its own website."}
   ```
   That's correct. It means the guard works: your browser tab isn't on your site's list.

> The 30-requests-per-minute limit per visitor comes from `wrangler.toml` and is only set up this way (via the repository), not by editing in the dashboard.

## Part 4 — Turn on the site (GitHub Pages)

1. On github.com, open your repository → **Settings** (top tabs) → **Pages** (left menu).
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Still in **Settings**: left menu **Secrets and variables → Actions** → tab **Variables** → **New repository variable**:
   - Name: `LOGO_API`
   - Value: your logo finder address from Part 3, step 7 (no slash at the end)
   - **Add variable**.
   (It's a variable, not a secret: the address ends up in the public site anyway, and that's fine. The protection is the site list and the rate limit.)
4. Top tabs → **Actions** → click **Deploy to GitHub Pages** in the left list → **Run workflow** → **Run workflow**.
5. Wait for the green tick (2–3 minutes). It runs all 89 automated tests first; if any fails, nothing is published.
6. Your site is live at:
   ```
   https://YOUR-GITHUB-NAME.github.io/logo-to-l3go/
   ```

## Part 5 — Check it works

1. Open your site. Click one of the made-up example logos. A sign should build in 3D.
2. Type a website, e.g. `pypi.org`, and click **Find logo**. You should see a row of images found on that site, and the first one building.
3. Drop a PNG or SVG logo from your computer.

If step 2 fails, see Troubleshooting below.

## Part 6 — Lock it down (do this once everything works)

1. **Remove `localhost` from the allow list.** Edit `logo-api/wrangler.toml` on github.com again and change the line to just your site:
   ```toml
   ALLOWED_ORIGINS = "https://YOUR-GITHUB-NAME.github.io"
   ```
   Commit. Cloudflare redeploys the logo finder by itself within a minute or two.
2. **Turn on Dependabot alerts** (warns you about vulnerable packages): repository **Settings → Code security** → enable **Dependabot alerts** and **Dependabot security updates**.
3. **Protect your accounts**: turn on two-factor sign-in on both GitHub and Cloudflare. Someone with your GitHub account can change the site; someone with your Cloudflare account can change the logo finder.
4. **Watch usage now and then**: Cloudflare dashboard → your Worker → **Metrics**. If you ever see abuse (thousands of requests you can't explain), lower `limit = 30` in `wrangler.toml`, or pause the Worker (Settings → **Disable**). The site keeps working with file uploads.

---

## Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| "Website search isn't set up on this copy of the site" | `LOGO_API` variable missing or the site wasn't rebuilt after adding it | Part 4 steps 3–4 |
| "We couldn't reach the logo finder" | Wrong address in `LOGO_API`, or the Worker isn't deployed | Open `LOGO_API` + `/find?site=example.com` in a browser: you should get the JSON error from Part 3 step 8 |
| "This logo finder only answers its own website" on your site | `ALLOWED_ORIGINS` doesn't exactly match your site's origin | Must be `https://your-name.github.io`: lowercase, no `/logo-to-l3go`, no trailing slash |
| Cloudflare build fails with a name error | Worker name ≠ `logo-to-bricks-api` | Rename the Worker, or change `name` in `wrangler.toml` to match |
| GitHub Action fails at "npm test" | A test broke after a change | Open the failed run to read which test; undo the last change |
| Site shows a 404 | Pages source not set to GitHub Actions, or the workflow hasn't run | Part 4 steps 2 and 4 |
| A site's logo isn't found, or looks wrong | Some sites draw their logo with code tied to their own page, or block robots | Download the logo yourself (try the site's "press" or "brand" page) and drop the file |
| "That website answered with an error (403)" | The site blocks automated visitors | Same as above: drop the file |

## Trying it on your own computer (optional)

Needs Node.js 22+ (https://nodejs.org). In a terminal, inside the `logo-to-bricks` folder:

```bash
npm ci                 # install exactly the tested versions
npm test               # 89 tests
npm run dev            # site at http://localhost:5173 (file upload works)
```

For website search locally, in a second terminal:

```bash
cd logo-api
npx wrangler dev       # logo finder at http://localhost:8787
```

and start the site with `VITE_LOGO_API=http://localhost:8787 npm run dev`.
