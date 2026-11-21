# Deploy and verify QueueTix M0

Use a personal GitHub account, one Atlas Free cluster, one Render Free web service, and a Vercel Hobby project. Hobby is for personal, non-commercial use. Keep provider plan and usage limits in view. Render Free normally sleeps after 15 minutes without inbound traffic and may take about a minute to wake. Atlas free limits and region availability can change. Check the plan labels as you create each resource. [Render Free](https://render.com/docs/free) · [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) · [Vercel Hobby](https://vercel.com/docs/plans/hobby)

## 1. GitHub

1. Sign in to GitHub. Click **+** → **New repository**. Choose your personal account under **Owner** and enter `queuetix` for **Repository name**.
2. Use **Public** for a public portfolio repository or choose **Private** to keep the source private. For a private repository, verify that the GitHub identity tied to the commit author is the Vercel Hobby owner. [Vercel commit author requirements](https://vercel.com/docs/deployments/troubleshoot-project-collaboration)
3. Leave README, .gitignore, and license initialization off. Click **Create repository**.
4. Copy the HTTPS remote from **Quick setup**. Substitute your GitHub handle below and run the commands from the local QueueTix root.

   ```powershell
   git status --short
   git remote add origin https://github.com/YOUR-GITHUB-HANDLE/queuetix.git
   git push -u origin main
   ```

5. Refresh the repository. Confirm the branch is `main` and both workspaces and the root lockfile are there. Keep .env files and source attachments local. [Push an existing repository](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

## 2. MongoDB Atlas

1. Sign in to [Atlas](https://cloud.mongodb.com/), use the project picker to create a project called **QueueTix**, and open **Database** → **Clusters** → **Create**. Choose **Free** (formerly M0), a region close to your intended Render region, and name the cluster `queuetix`. Leave sample data off and click **Create**. [Create an Atlas Free cluster](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/)
2. In **Security** → **Database & Network Access** → **Database Users**, click **Add New Database User**. Choose **Password**, use `queuetix-app` as the username, and generate a strong password. Store it in your password manager. If the setup wizard already created this user, edit it here.
3. Under **Specific Privileges**, add `readWrite` on `tickets_dev` and a second `readWrite` on `tickets_prod`. Leave **Collection** empty for both entries. Remove any default built-in role that grants access to other databases. If the cluster selector is available, restrict the user to the QueueTix cluster. Click **Add User** or **Update User**. [Database users and scoped roles](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/) · [Specific privileges](https://www.mongodb.com/docs/atlas/data-federation/tutorial/advanced-security-options/advanced-db-user-config/?interface-default-atlas-cli=atlas-ui)
4. In the same security area, select **IP Access List** → **Add IP Address**. Add **Your Current IP Address** only if you plan to connect from your machine. Add Render’s outbound ranges after you create its service. Use the published regional ranges to avoid opening access to the entire internet. [Atlas IP access list](https://www.mongodb.com/docs/atlas/security/ip-access-list/) · [Render outbound ranges](https://render.com/docs/outbound-ip-addresses)
5. On the cluster card, select **Connect** → **Drivers** → **Node.js**. Copy the SRV template privately. Replace the credentials locally, percent-encoding special characters in the username and password. Insert `/tickets_prod` before the query string, keep the provided options, and ensure `authSource=admin` is present once. Use the template below for production and substitute `/tickets_dev` for development.

   ```text
   mongodb+srv://USER:ENCODED_PASSWORD@CLUSTER_HOST/tickets_prod?retryWrites=true&w=majority&authSource=admin
   ```

6. If you want both databases to appear in Atlas before app startup, open the cluster in **Data Explorer** → **Create Database**, and create each database with an initial `smoke` collection. Otherwise each database first appears when its own startup probe creates collections. The probe creates `smoke_a` and `smoke_b` before using them in a transaction.

## 3. Render

1. Sign in to [Render](https://dashboard.render.com/). Click **New** → **Web Service** → **Git Provider**. Connect GitHub if needed, grant access to the QueueTix repository, then click **Connect** on that repository.
2. Set **Name** to `queuetix-api` or an available QueueTix name, **Language** to **Node**, **Branch** to `main`, and **Region** to the closest available region to Atlas. Leave **Root Directory** blank so the build uses the root workspace lockfile.
3. Enter the commands below. Choose **Free** for **Instance Type** and set **Advanced** → **Health Check Path** to `/health`. [Render web service settings](https://render.com/docs/web-services)

   | Setting           | Value                                                                      |
   | ----------------- | -------------------------------------------------------------------------- |
   | Build Command     | `npm ci --omit=dev --workspace=server && npm run build --workspace=server` |
   | Start Command     | `npm run start --workspace=server`                                         |
   | Health Check Path | `/health`                                                                  |

4. In **Environment Variables**, add `NODE_VERSION=22`, `NODE_ENV=production`, `MONGODB_URI` with the private Atlas production URI, and `CLIENT_ORIGIN=http://localhost:5173` as a temporary value. Let Render supply `PORT`. Click **Deploy Web Service** or **Create Web Service**. [Render Node version](https://render.com/docs/node-version)
5. Open the new service → **Connect** (top right) → **Outbound**. Copy every listed CIDR. In Atlas return to **IP Access List** → **Add IP Address**, add each CIDR separately with a QueueTix Render comment, and wait for the entries to become active. If the Outbound tab is unavailable, use Render’s documented ranges for the selected region. No unrestricted entry is required when those ranges are available. [Render outbound ranges](https://render.com/docs/outbound-ip-addresses)
6. If startup ran before the CIDRs took effect, use **Manual Deploy** → **Restart service** once after the entries turn active. Copy the service’s stable HTTPS origin (for example, `https://YOUR-RENDER-SERVICE.onrender.com`). Open its **Logs** and look for the `QueueTix database probe` summary. Open `/health` and `/health/db` on the Render origin. The latter must report `ok: true`, `mongo: true`, `txn: true`, and a completed `checkedAt`.
7. If Atlas transaction readiness fails, stop M0 verification. Copy the exact sanitized `QueueTix database probe failed` log with the transaction stage, server error code, labels, and message. Share that line with the developer. Keep the URI, user name, password and topology private. Keep the transaction requirement in place.

## 4. Vercel

1. Sign in to [Vercel](https://vercel.com/) under your personal **Hobby** scope. Click **Add New** → **Project**. Connect GitHub if needed, select the QueueTix repo, and click **Import**.
2. Set **Project Name** to `queuetix` or an available QueueTix name. In **Configure Project**, set **Framework Preset** to **Vite**. Click **Edit** beside **Root Directory**, select `client`, and confirm. Ensure **Include source files outside of the Root Directory in the Build Step** is enabled so npm can use the workspace lockfile. [Vercel monorepos](https://vercel.com/docs/monorepos)
3. In **Build and Output Settings**, enable overrides and enter these values. Use Node.js **22.x** under project **Settings** → **Build and Deployment** if the project exposes the version setting after initial creation. If you change it there, redeploy from **Deployments** → deployment menu → **Redeploy**. [Vercel build configuration](https://vercel.com/docs/project-configuration) · [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

   | Setting          | Value                                               |
   | ---------------- | --------------------------------------------------- |
   | Install Command  | `npm ci --include=dev --workspace=@queuetix/client` |
   | Build Command    | `npm run build --workspace=@queuetix/client`        |
   | Output Directory | `dist`                                              |

4. In **Environment Variables**, add `VITE_API_URL` using the Render HTTPS origin, with no path. Enable it for **Production**. Click **Deploy**. `VITE_API_URL` is public and the only client environment variable needed in M0.
5. Open the Vercel project’s **Settings** → **Domains**. Copy the stable production HTTPS origin. In Render, open the service → **Environment** → **Edit** and replace `CLIENT_ORIGIN` with that exact origin. Use scheme and hostname only, with no trailing slash, path, wildcard, or preview URL. Click **Save, rebuild, and deploy** or wait for the new deploy if saving starts it automatically.
6. Open the production URL at `/smoke` once Render reports the new deploy is live. The repo’s Vercel rewrite serves this direct link.

## 5. Record acceptance evidence

1. Run `npm test` locally. The DB test must complete against MongoMemoryReplSet. On Vercel, run the browser checks. Confirm **API**, **Database**, **Transaction**, **CORS**, and **Incremental SSE** all show PASS. Match the transaction timestamp with `/health/db` and the Render startup log.
2. Open Chrome DevTools → **Network**. Clear it, click **Run checks**, and filter for `health/cors`. Confirm the **OPTIONS** request includes `Access-Control-Request-Headers: authorization`, returns HTTP 204, and includes the exact Vercel origin in `Access-Control-Allow-Origin`. Confirm the following GET returns HTTP 200.
3. Watch **Stream arrivals** while the requests are running. Confirm ten rows appear one at a time, with consecutive gaps near two seconds, followed by a PASS. Record browser, sample gaps and the completed screenshot. A late burst of rows is a failure.
4. Close tabs sending requests to the service and allow Render to idle for **20 minutes**. In PowerShell run the command below once, using your Render origin. Save the HTTP status, total elapsed time in seconds, and test date. PASS requires the first call to return QueueTix JSON and HTTP 200 within 90 seconds. A wake page, timeout, or need to retry does not pass. Reopen `/smoke` afterward and confirm the startup `checkedAt` advanced.

   ```powershell
   curl.exe --silent --show-error --max-time 90 --write-out '\nHTTP %{http_code} in %{time_total} seconds\n' https://YOUR-RENDER-SERVICE.onrender.com/health
   ```

5. Use a disallowed origin for a real browser negative check. Leave `CLIENT_ORIGIN` set to the Vercel origin only. Run the local client from the repo root with port 5173 free, then open `http://localhost:5173/smoke` in a new private browser window.

   ```powershell
   $env:VITE_API_URL = 'https://YOUR-RENDER-SERVICE.onrender.com'
   npm run dev --workspace=client
   ```

   In **Network**, the `/health/cors` preflight from localhost must be rejected with no matching allow-origin header, and the follow-up Authorization GET must be absent. The local page should show **CORS FAIL**. Stop the local server with Ctrl+C and clear the temporary variable with `Remove-Item Env:VITE_API_URL`.

6. On the deployed page, use Chrome DevTools → **Toggle device toolbar** to check widths 320, 375, 768, 1024, and 1440 px. Check for clipping, sideways overflow, correct reading order and visible keyboard focus on the wordmark and Run checks button. Capture at least 375 and 1440 px with results visible.
7. Record the public GitHub, Render and Vercel URLs, screenshots or summarized measurements, cached probe timestamp, cold-start time, and rejected origin in `docs/PROGRESS.md`. If any Atlas transaction attempt failed, include the exact sanitized log and stop.
