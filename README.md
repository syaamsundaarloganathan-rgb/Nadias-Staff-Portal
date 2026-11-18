# Nadia Group Staff Portal

Leave applications, daily sales for Nadia Pharmacy, Dental and Clinic, and Wholesale daily tasks, in one app staff use on their phones.

- **Staff** sign in with their own 8-digit passcode, apply for leave (with MC photo), see their leave days, submit daily sales and Wholesale updates.
- **HR Manager** and **Director** see every request the moment it is sent, approve or reject it, and manage staff, holidays, policy and year-end carry forward.
- Bahasa Malaysia / English switch, works on iPhone and Android, installs to the home screen with the Nadia icon.

There are two ways to run it:

| | Demo mode | Live mode |
|---|---|---|
| What it's for | Trying the app on phones | Real use by all staff |
| Where data is kept | On each phone only | Supabase database (shared, live) |
| Setup time | About 10 minutes | About 45 minutes |
| Cost | Free | Free to start; US$25/month recommended (see Costs) |

---

## Part A. Try it on phones (demo mode, about 10 minutes)

1. **Create a GitHub repository.** Sign in at github.com → **New repository** → name it `nadia-staff-portal` → choose **Public** → **Create repository**.
   (On a free GitHub account, GitHub Pages only works for public repositories. That's fine: the code holds no passwords or data.)
2. **Upload the files.** On the new repository page click **uploading an existing file**, then drag in *everything inside* this folder (including the hidden `.github` folder, see the tip below). Click **Commit changes**.
   - Tip: if your computer hides the `.github` folder, use GitHub Desktop, or create the file on GitHub with **Add file → Create new file**, name it `.github/workflows/deploy-pages.yml`, and paste in that file's contents.
3. **Turn on GitHub Pages.** Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Wait 1–2 minutes.** Open the **Actions** tab; when "Deploy to GitHub Pages" has a green tick, your link is `https://<your-github-name>.github.io/nadia-staff-portal/`.
5. **Open the link on your phone.** Sign in with a demo passcode:
   - Director `11111111` · HR `22222222` · Staff `30000001` to `30000020`
6. **Add it to the home screen.** iPhone: Safari → Share → **Add to Home Screen**. Android: Chrome → ⋮ → **Add to Home screen**. It opens full screen with the Nadia icon.

In demo mode each phone keeps its own data, so the Director won't see a leave applied on another phone. That's what live mode adds.

---

## Part B. Go live with a shared, real-time database (Supabase)

### 1. Create the Supabase project
1. Sign up at supabase.com → **New project**.
2. Name: `nadia-staff-portal`. Region: **Southeast Asia (Singapore)**. Set a strong database password and keep it safe.

### 2. Create the tables and security rules
1. In the project: **SQL Editor → New query**.
2. Open `supabase/schema.sql` from this folder, copy everything, paste it in, click **Run**. You should see "Success".

This sets the rules that the database itself enforces, even if someone tampers with the app:
- Staff can only see and change their own leave, tasks and sales.
- Nobody can approve their own leave. Only the Director can approve daily sales.
- Only HR and the Director see the staff list. Only the Director can change someone's role.
- MC slips are private: each person sees their own; HR and the Director see all.

### 3. Close public sign-ups
**Authentication → Sign In / Providers → User Signups**: turn **off** "Allow new users to sign up". Accounts are created only by the passcode script in step 5.

### 4. Add the "New passcode" function
This lets HR give someone a new passcode from the app (lost or shared passcode).
- **Easiest:** **Edge Functions → Deploy a new function → Via Editor**, name it `reset-passcode`, paste in `supabase/functions/reset-passcode/index.ts`, and deploy.
- **Or with the command line:** `npx supabase login`, then `npx supabase functions deploy reset-passcode --project-ref <your-project-ref>`.

### 5. Create the 22 passcodes
You need Node.js 18 or newer (nodejs.org) on a computer.
1. In Supabase: **Project Settings → API Keys**. Copy the **Project URL** and the **secret (service_role) key**. This key can do anything: never put it in the app, on GitHub or in a chat.
2. In a terminal, inside this folder's `scripts` folder:
   ```
   npm install
   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=your-secret-key npm run create
   ```
   On Windows PowerShell, set the two values first: `$env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; npm run create`
3. It creates **1 Director, 1 HR Manager and 20 staff slots** (S01–S20), each with its own random 8-digit passcode, and saves them in `scripts/passcodes.csv`.
   - Need more staff slots later? Run it again with `STAFF_COUNT=30`. It only adds the new slots.
4. Hand each passcode out privately, then delete `passcodes.csv`. It is never uploaded (see `.gitignore`).

### 6. Connect the app to the database
1. In Supabase: **Project Settings → API Keys**. Copy the **Project URL** and the **publishable (anon) key**. The anon key is designed to be public; the rules from step 2 protect the data.
2. On GitHub, open `config.js` → ✏️ edit → paste the two values:
   ```js
   window.NADIA_CONFIG = {
     supabaseUrl: 'https://xxxx.supabase.co',
     supabaseAnonKey: 'your-publishable-or-anon-key'
   };
   ```
3. **Commit changes.** GitHub Pages republishes in about a minute. The demo passcodes stop working and the real ones start.

### 7. First sign-in
- Each person enters their passcode. The first time, the app asks for their **full name** (and, for staff, **where they work**: Pharmacy, Wholesale, Dental or Clinic), then shows the 3-screen welcome guide.
- From then on the app remembers them on that phone until they sign out.
- HR then opens **Staff & settings** to add each person's date joined and leave allowances. The app flags anyone below the Employment Act minimum.

---

## How the live updates work
When a staff member submits leave or daily sales, it is saved to Supabase and pushed straight to every open HR and Director screen. They get a pop-up ("New leave request: …"), and the Approvals badge goes up, with no refresh needed. When HR or the Director decides, the staff member's screen updates the same way. If a phone was asleep, the app catches up as soon as it is opened again.

## Costs
- **GitHub Pages:** free (public repository).
- **Supabase Free:** enough for 20 staff (500 MB database, 1 GB file storage). The catch: no automatic backups, and a project with no activity for 7 days is paused (daily use prevents this).
- **Supabase Pro, US$25/month:** never pauses, adds daily backups and email support. Recommended once real leave records are being kept.

## What's different from the Claude version
- Sign-in is by personal 8-digit passcode instead of staff ID + PIN.
- Staff only ever see their own records. The leave calendar shows staff their own leave plus public holidays; HR and the Director see everyone.
- Not included yet (they ran inside Claude): the AI briefing, the 6pm summary email to the Director, and the 5:50pm Wholesale reminder email. They can be added later with Supabase scheduled functions and an email service.

## Files
| File | What it is |
|---|---|
| `index.html` | The app |
| `config.js` | Your Supabase address and public key (empty = demo mode) |
| `js/backend.js` | Connects the app to Supabase (or to the phone, in demo mode) |
| `js/holidays.js` | Holiday list used in demo mode |
| `manifest.webmanifest`, `icons/` | Home-screen name and icon |
| `img/` | Nadia Pharmacy, Dental and Clinic logos |
| `supabase/schema.sql` | Tables, security rules, file storage, live updates |
| `supabase/functions/reset-passcode/` | "New passcode" function for HR |
| `scripts/create-passcodes.mjs` | Creates the passcodes |
| `.github/workflows/deploy-pages.yml` | Publishes to GitHub Pages automatically |

## Trying it on a computer
Open a terminal in this folder and run `python3 -m http.server 8080`, then visit `http://localhost:8080`.
