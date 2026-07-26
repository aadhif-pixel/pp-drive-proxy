# Deploying the Drive proxy to Cloud Run — Console UI only (no gcloud CLI)

This backend replaces "everyone signs in with Google" with one shared
username/password. The backend holds a Google **service account** and does
all the Drive reading/writing itself; the front-end just logs in with a
password and calls this backend instead of `googleapis.com` directly.

Because Cloud Run's "deploy from source" UI needs your code sitting in a
repo to build it, the one non-Console step is putting these files on
GitHub — done entirely by dragging files into the browser, no git install
needed.

## 1. Put the code on GitHub
1. Go to https://github.com and sign in (create a free account if needed).
2. Click the **+** in the top right → **New repository**.
3. Name it e.g. `pp-drive-proxy`, set it to **Private**, click **Create repository**.
4. On the new repo page, click **Add file → Upload files**.
5. Drag in `server.js`, `package.json`, `Dockerfile`, `README.md` (skip `.env.example` if you like — it has no secrets in it, just labels, but it's fine to include either way).
6. Click **Commit changes**.

## 2. Enable the APIs you need
Go to https://console.cloud.google.com, make sure the right project is selected in the top bar, then:
1. Search bar at top → type **"APIs & Services"** → open it → **Library**.
2. Search **"Google Drive API"** → click it → **Enable**.
3. Search **"Secret Manager API"** → click it → **Enable**.
4. Search **"Cloud Run Admin API"** → click it → **Enable** (it may already be on).
5. Search **"Cloud Build API"** → click it → **Enable** (needed for the Console to build your container from the GitHub repo).

## 3. Create a service account for Drive access
1. Search bar → **"Service Accounts"** → open **IAM & Admin → Service Accounts**.
2. Click **+ Create Service Account**.
3. Name it e.g. `pp-drive-bot` → **Create and Continue**.
4. You don't need to grant it any project-level roles — click **Continue**, then **Done**.
5. Click on the service account you just created → the **Keys** tab.
6. **Add Key → Create new key → JSON → Create**. A file downloads — call it `sa-key.json`. Keep it private; you'll paste its contents into Secret Manager next, then you can delete the local copy.

## 4. Share your Drive folder with the service account
1. Open `sa-key.json` in a text editor and copy the `client_email` value (looks like `pp-drive-bot@your-project.iam.gserviceaccount.com`).
2. Open your shared Drive folder: https://drive.google.com/drive/folders/19J9l7vsZxEWAVdnuTJhm-QgTWjUO9ape
3. Click **Share**, paste in that email, set access to **Editor**, click **Share** (uncheck "Notify people" if you want — it's a robot).

Skipping this step is the #1 cause of 403/404 errors later — the service account can only see files it's been explicitly shared.

## 5. Create your secrets in Secret Manager
Search bar → **Secret Manager** → **+ Create Secret**, repeat 3 times:

**Secret 1 — the service account key**
- Name: `GOOGLE_SERVICE_ACCOUNT_KEY`
- Secret value: click **Upload file**, choose `sa-key.json`
- Click **Create Secret**

**Secret 2 — your shared password**
- Name: `APP_PASSWORD`
- Secret value: type the password your whole team will log in with
- Click **Create Secret**

**Secret 3 — session signing key**
This just needs to be a long random string — you don't need any install to make one:
- Open a new browser tab, press **F12** (or right-click → Inspect) to open DevTools, click the **Console** tab.
- Paste this and press Enter:
  `[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('')`
- Copy the string it prints (in quotes).
- Back in Secret Manager: Name `SESSION_SECRET`, paste that string as the value, **Create Secret**.

## 6. Deploy to Cloud Run
1. Search bar → **Cloud Run** → **Create Service**.
2. Choose **Continuously deploy from a repository (source or function)** → **Set up with Cloud Build**.
3. Click **Connect new repository** → choose **GitHub** → authenticate/authorize Google Cloud Build to access your GitHub account → select the `pp-drive-proxy` repo → **Connect**.
4. Branch: `main` (or whatever you committed to). Build type: it should auto-detect the **Dockerfile**. Click **Save**.
5. Back on the Create Service screen:
   - **Service name**: `pp-drive-proxy`
   - **Region**: pick one close to your team
   - **Authentication**: select **Allow unauthenticated invocations** (your own password check is what gates access, not Cloud Run's IAM)
6. Expand **Container, Networking, Security** → **Container** tab:
   - **Container port**: `8080`
7. Same section → **Variables & Secrets** tab:
   - Under **Environment variables**, click **Add variable** twice:
     - `APP_USERNAME` = `team` (or whatever you want teammates to type)
     - `DRIVE_FOLDER_ID` = `19J9l7vsZxEWAVdnuTJhm-QgTWjUO9ape`
   - Under **Secrets**, click **Reference a secret** three times, once each for:
     - `APP_PASSWORD` → expose as environment variable named `APP_PASSWORD`, version `latest`
     - `SESSION_SECRET` → expose as environment variable named `SESSION_SECRET`, version `latest`
     - `GOOGLE_SERVICE_ACCOUNT_KEY` → expose as environment variable named `GOOGLE_SERVICE_ACCOUNT_KEY`, version `latest`
   - If a banner appears saying the Cloud Run service account needs access to a secret, click **Grant Access** right there. (If it doesn't prompt automatically: go to **Secret Manager** → click the secret → **Permissions** tab → **Grant Access** → add `PROJECT_NUMBER-compute@developer.gserviceaccount.com` with role **Secret Manager Secret Accessor**. Find your project number under **IAM & Admin → Settings**.)
8. Click **Create**. Cloud Build will pull your repo, build the Dockerfile, and deploy — this takes a minute or two. Watch the build logs on screen.
9. When it finishes, the service page shows a **URL** like `https://pp-drive-proxy-xxxxxxxxxx-uc.a.run.app` — this is your `BACKEND_URL`, needed for the front-end.

## 7. Test it
- Visit the Service URL directly in your browser — you should see `Pacific Power Drive proxy is running.`
- To test the login/data endpoints without a terminal, the easiest way is to just wire up the front-end (next step) and try logging in there — it'll immediately tell you if something's misconfigured.

## 8. Point the front-end HTML files at it
This is the part that changes inside `quotation_final.html` and
`report_final.html`:
- Remove the `accounts.google.com/gsi/client` script tag and the whole
  `DRIVE_CONFIG` / `tokenClient` / `signIn` / `signOut` OAuth block.
- Replace the "Sign in with Google" screen with a plain username/password
  form that POSTs to `BACKEND_URL/api/login` with `credentials: "include"`.
- Replace every direct call to `https://www.googleapis.com/...` with a call
  to `BACKEND_URL/api/drive/file?name=...` (GET to load, PUT to save) or
  `BACKEND_URL/api/drive/list` — again with `credentials: "include"` so the
  session cookie is sent.

If the HTML files are opened from a different web address than the backend
(e.g. hosted on GitHub Pages), go back to the Cloud Run service → **Edit &
Deploy New Revision** → add another environment variable:
`ALLOWED_ORIGIN` = the exact URL where the HTML is hosted.

I can make these front-end edits directly in both HTML files for you — just
say the word and I'll wire them up against this backend once you've got the
Service URL.
