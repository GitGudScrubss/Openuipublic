# Installing OpenUI on macOS (Beta)

> **Why this page exists:** the beta builds of OpenUI are **ad-hoc signed but not
> notarized by Apple** (notarization requires a paid Apple Developer account,
> which we'll add before general availability). Because of that, macOS Gatekeeper
> will warn you the first time you open the app — with a message like
> *"OpenUI can't be opened because Apple cannot check it for malicious software"*
> or *"OpenUI is from an unidentified developer."*
>
> This is expected for a beta and does **not** mean the app is unsafe. Follow one
> of the two methods below to open it. You only need to do this **once** — after
> the first launch, macOS remembers your choice and future launches (and
> auto-updates) open normally.

---

## Which download do I want?

Grab the latest `.dmg` from the [Releases page](https://github.com/Satyabrat2005/Openui/releases):

| Your Mac | File |
| --- | --- |
| Apple Silicon (M1/M2/M3/M4) | `OpenUI-arm64.dmg` |
| Intel | `OpenUI-x64.dmg` |

Not sure which you have?  → Apple menu () → **About This Mac** → look at "Chip"
(Apple M-series = arm64) vs "Processor" (Intel = x64).

Open the `.dmg` and drag **OpenUI** into your **Applications** folder as usual.

---

## Method 1 — Right-click → Open (easiest, recommended)

1. Open your **Applications** folder in Finder.
2. **Right-click** (or Control-click) **OpenUI**.
3. Choose **Open** from the menu.
4. In the dialog that appears, click **Open** again.

That's it. The app launches and macOS will let it open normally from now on
(double-click works forever after).

> Double-clicking the app the *normal* way the first time will only offer a
> **Cancel / Move to Trash** dialog with no "Open" button — that's why you must
> use right-click → Open for the very first launch.

---

## Method 2 — Terminal (if right-click → Open doesn't offer an "Open" button)

On recent macOS versions, apps downloaded via a browser get a stricter
"quarantine" flag. If Method 1 doesn't work, remove the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/OpenUI.app
```

Then open OpenUI normally (double-click). Requires no admin password.

> `-dr` = **d**elete the attribute **r**ecursively across the whole app bundle.
> This only removes the "downloaded from the internet" marker; it changes nothing
> else about the app.

---

## Auto-updates

Once OpenUI is open, **updates are automatic** — you do **not** need to repeat
these steps for future versions. OpenUI checks GitHub Releases, downloads the
update in the background, and applies it on restart. The Gatekeeper prompt only
happens on that very first manual install.

---

## Troubleshooting

**"The application is damaged and can't be opened."**
This is Gatekeeper reacting to the quarantine flag on some macOS versions. Run
the Method 2 command above (`xattr -dr com.apple.quarantine …`) and try again.

**System Settings → Privacy & Security route.**
If you double-clicked and got blocked, you can also go to  → **System Settings**
→ **Privacy & Security**, scroll down, and click **Open Anyway** next to the
OpenUI message, then confirm. (Methods 1 and 2 above are faster.)

**Still stuck?**
Open an issue at <https://github.com/Satyabrat2005/Openui/issues> with your macOS
version (Apple menu → About This Mac) and a screenshot of the error.

---

*Windows users:* no Gatekeeper equivalent applies — just run
`OpenUI-Setup-<version>.exe`. SmartScreen may show a "Windows protected your PC"
notice for a new publisher; click **More info → Run anyway**.
