<#
    Publish S2S to GitHub.

    Run `gh auth login` first - that step needs a browser or a token and cannot
    be automated on your behalf.

    What this does:
      1. works out your GitHub username from the authenticated session
      2. rewrites the __GH_OWNER__ placeholders in README.md and site/index.html
      3. creates the public repository and pushes
      4. turns on GitHub Pages for the site/ directory
      5. builds the release artifacts and attaches them to a v0.1.0 release

    It is safe to re-run: each step checks whether it has already been done.

    Usage:
        powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
        powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -Repo my-sns -DryRun
#>

param(
    [string]$Repo = "s2s",
    [string]$Tag = "v0.1.0",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }

try {
    # gh may have been installed into the per-user WinGet links directory,
    # which an already-open shell will not have on its PATH yet.
    $ghLinks = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    if ((Test-Path $ghLinks) -and ($env:PATH -notlike "*$ghLinks*")) { $env:PATH = "$ghLinks;$env:PATH" }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI not found. Install it with: winget install --id GitHub.cli"
    }

    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Not logged in to GitHub. Run 'gh auth login' first, then re-run this script."
    }

    $owner = (gh api user --jq .login).Trim()
    if (-not $owner) { throw "could not read your GitHub username" }
    Step "publishing as $owner/$Repo"

    if ($DryRun) {
        Note "dry run: stopping before anything is created or pushed"
        return
    }

    # ---- 1. fill in the placeholders ------------------------------------

    Step "filling in repository links"
    $changed = $false
    foreach ($file in @("README.md", "site\index.html")) {
        $text = Get-Content $file -Raw -Encoding UTF8
        if ($text -match "__GH_OWNER__") {
            # -NoNewline keeps the file byte-identical apart from the swap.
            ($text -replace "__GH_OWNER__", $owner) |
                Set-Content $file -NoNewline -Encoding UTF8
            Note "$file"
            $changed = $true
        }
    }
    if ($changed) {
        git add README.md site/index.html
        git commit -q -m "point the links at $owner/$Repo"
    } else {
        Note "already done"
    }

    # ---- 2. create the repository and push -------------------------------

    Step "creating the repository"
    gh repo view "$owner/$Repo" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Note "$owner/$Repo already exists"
        if (-not (git remote get-url origin 2>$null)) {
            git remote add origin "https://github.com/$owner/$Repo.git"
        }
    } else {
        gh repo create $Repo --public `
            --description "サーバーを持たない完全P2P型のSNS。Twitter型・Instagram型・2ch型を、ひとつの署名付きログの上に。" `
            --source . --remote origin
        if ($LASTEXITCODE -ne 0) { throw "could not create the repository" }
    }

    Step "pushing"
    git branch -M main
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw "push failed" }

    # ---- 3. GitHub Pages -------------------------------------------------

    Step "turning on GitHub Pages"
    $pagesBody = '{"source":{"branch":"main","path":"/site"}}'
    $pagesBody | gh api "repos/$owner/$Repo/pages" -X POST --input - 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        # Already enabled, or the source needs updating rather than creating.
        $pagesBody | gh api "repos/$owner/$Repo/pages" -X PUT --input - 2>&1 | Out-Null
    }
    Note "https://$owner.github.io/$Repo/  (live in a minute or two)"

    # ---- 4. release artifacts -------------------------------------------

    Step "building the release artifacts"
    $out = Join-Path $root "release"
    New-Item -ItemType Directory -Force -Path $out | Out-Null

    npm run build:web
    if ($LASTEXITCODE -ne 0) { throw "the web build failed" }
    if (Test-Path "$out\s2s-web.zip") { Remove-Item "$out\s2s-web.zip" }
    Compress-Archive -Path "packages\ui\dist\*" -DestinationPath "$out\s2s-web.zip"

    $apk = "apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk"
    if (-not (Test-Path $apk)) {
        Note "building the Android APK"
        npm run mobile:build
    }
    if (Test-Path $apk) { Copy-Item $apk "$out\S2S-android.apk" -Force }
    else { Note "no APK: skipping (build it with 'npm run mobile:build')" }

    $exe = "rust\s2s-peer\target\release\s2s-peer.exe"
    if (-not (Test-Path $exe)) {
        Note "building the Rust peer"
        cargo build --release --manifest-path rust/s2s-peer/Cargo.toml
    }
    if (Test-Path $exe) { Copy-Item $exe "$out\s2s-peer-windows-x64.exe" -Force }
    else { Note "no Rust binary: skipping (see docs/RUST.md)" }

    Step "creating the $Tag release"
    $assets = Get-ChildItem $out -File | ForEach-Object { $_.FullName }
    Note ("attaching: " + (($assets | Split-Path -Leaf) -join ", "))

    gh release view $Tag 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        gh release upload $Tag $assets --clobber
    } else {
        gh release create $Tag $assets --title "S2S $Tag" --notes-file "docs\RELEASE-NOTES.md"
    }
    if ($LASTEXITCODE -ne 0) { throw "could not create the release" }

    Write-Host "`nDone." -ForegroundColor Green
    Write-Host "  repository  https://github.com/$owner/$Repo"
    Write-Host "  site        https://$owner.github.io/$Repo/"
    Write-Host "  release     https://github.com/$owner/$Repo/releases/tag/$Tag"
    Write-Host ""
}
finally {
    Pop-Location
}
