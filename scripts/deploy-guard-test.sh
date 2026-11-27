#!/usr/bin/env bash
# fly-deploy.sh, EXERCISED WITHOUT A DEPLOY. `bash scripts/deploy-guard-test.sh` (a few seconds).
#
# 1. THE PRODUCTION GUARD. The script refuses to deploy production from anything but a clean
#    commit on main (`require_main_tree`). Its `--check` is run in throwaway repositories for
#    every case the rule has: main, a detached release worktree, a rollback, an unpushed commit,
#    another branch, uncommitted and untracked files, the override, the two cross-wired app names.
# 2. THE RE-SHRINK AFTER A LISTING FLAKE. After the deploy the script lists the machines to put
#    each satellite back on its own size. That listing is retried once, and a second failure is
#    said out loud and fails the script, instead of ending it silently with every satellite left
#    on fly.toml's size.
# 3. THE ZENITH FETCH IS PART OF `--check`. The vendored tarballs are fetched (or refused) before the
#    `--check` exit, so announce-deploy.sh cannot count down to a deploy that dies at the fetch.
#
# `fly` is a stub, first on PATH. In part 1 it fails loudly: a case that got past the check and
# reached a deploy shows as FLY CALLED. In part 2 it plays a deploy that works and a listing
# that fails as many times as the case asks. Nothing here can touch a real app. Run it after any
# change to fly-deploy.sh; `npm run test:mm` only holds that the guard is still asked first.
set -u
SCRIPT="$(cd "$(dirname "$0")" && pwd)/fly-deploy.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/stub"
printf '#!/usr/bin/env bash\necho "FLY CALLED: $*"\nexit 99\n' > "$T/bin/fly"
chmod +x "$T/bin/fly"
export PATH="$T/bin:$PATH"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
cd "$T/work" || exit 2
git checkout -q -b main
echo one > a.txt && git add a.txt && git commit -q -m one 2>/dev/null
echo two > a.txt && git commit -q -am two 2>/dev/null
git push -q origin main

fails=0
run() { # name, wanted exit code, a pattern its output must hold, then env pairs and the command
  local name="$1" want="$2" pat="$3"
  shift 3
  local out rc
  out=$(env "$@" 2>&1)
  rc=$?
  if [ "$rc" -eq "$want" ] && echo "$out" | grep -q -- "$pat" && ! echo "$out" | grep -q "FLY CALLED"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (exit $rc, wanted $want) :: $(echo "$out" | tr '\n' ' ' | cut -c1-220)"
    fails=$((fails + 1))
  fi
}

run "a pushed commit on branch main is allowed" 0 "ok to deploy PRODUCTION from main" bash "$SCRIPT" --check
git checkout -q --detach origin/main
run "a detached HEAD at origin/main is allowed (a release worktree)" 0 "ok to deploy PRODUCTION" bash "$SCRIPT" --check
git checkout -q --detach origin/main~1
run "an older commit of main is allowed (a rollback)" 0 "ok to deploy PRODUCTION" bash "$SCRIPT" --check
git checkout -q main
echo three > a.txt && git commit -q -am three 2>/dev/null
run "a commit on main that was not pushed is refused" 1 "not a commit on origin/main" bash "$SCRIPT" --check
run "...and DEPLOY_ANY_TREE=1 lets it through, saying so" 0 "DEPLOY_ANY_TREE=1: PRODUCTION from main" DEPLOY_ANY_TREE=1 bash "$SCRIPT" --check
git reset -q --hard origin/main
git checkout -q -b alpha
echo alpha > b.txt && git add b.txt && git commit -q -m alpha 2>/dev/null
run "another branch (alpha) is refused, by name" 1 "this tree is alpha @" bash "$SCRIPT" --check
run "...but --alpha is not asked about main" 0 "ok to deploy the alpha preview from alpha" bash "$SCRIPT" --alpha --check
run "--alpha onto the production app is refused" 1 "FLY_ALPHA_APP names the PRODUCTION app" FLY_ALPHA_APP=dohun-sim-decode bash "$SCRIPT" --alpha --check
git checkout -q main
echo dirty > a.txt
run "a tracked file with uncommitted changes is refused, and named" 1 "a.txt" bash "$SCRIPT" --check
git checkout -q -- a.txt
echo scratch > untracked.txt
run "an untracked file does not block a deploy" 0 "ok to deploy PRODUCTION" bash "$SCRIPT" --check
run "production's config onto the alpha app is refused" 1 "FLY_APP names the alpha app" FLY_APP=dsim-alpha bash "$SCRIPT" --check
mkdir -p "$T/plain" && cd "$T/plain" || exit 2
run "a directory that is not a git checkout is refused" 1 "not a git checkout" bash "$SCRIPT" --check

# ---- 2. the re-shrink after a listing flake ------------------------------------------------------
# The whole production path, against a stub: `deploy` works, `machine list` fails the first
# FAIL_LISTS times and then answers one satellite (ord) and the primary (iad), and every
# `machine update` is written down.
cat > "$T/bin/fly" <<'STUB'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "deploy "*) echo "stub deploy"; exit 0 ;;
  "machine list")
    n=$(cat "$FLY_STUB_DIR/lists" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$FLY_STUB_DIR/lists"
    if [ "$n" -le "${FAIL_LISTS:-0}" ]; then echo "api flake" >&2; exit 1; fi
    echo '[{"id":"m-ord","region":"ord","state":"started"},{"id":"m-iad","region":"iad","state":"started"}]' ;;
  "machine update") echo "$3" >> "$FLY_STUB_DIR/updates"; exit 0 ;;
  *) echo "FLY CALLED: $*"; exit 99 ;;
esac
STUB
chmod +x "$T/bin/fly"
cd "$T/work" || exit 2
rm -f untracked.txt
# the script fetches the vendored tarballs first; here that is a file that does nothing
mkdir -p scripts && echo "// stub" > scripts/fetch-zenith.mjs
git add scripts/fetch-zenith.mjs && git commit -q -m fetch 2>/dev/null && git push -q origin main

flake() { # name, listing failures, wanted exit code, a pattern, the machines that must be updated
  local name="$1" failing="$2" want="$3" pat="$4" updated="$5"
  rm -f "$T/stub/lists" "$T/stub/updates"
  local out rc got
  out=$(FLY_STUB_DIR="$T/stub" FAIL_LISTS="$failing" FLY_LIST_RETRY_S=0 bash "$SCRIPT" 2>&1)
  rc=$?
  got=""
  [ -f "$T/stub/updates" ] && got=$(tr '\n' ' ' < "$T/stub/updates")
  if [ "$rc" -eq "$want" ] && echo "$out" | grep -q -- "$pat" && [ "$got" = "$updated" ] && ! echo "$out" | grep -q "FLY CALLED"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (exit $rc, wanted $want; updated '$got', wanted '$updated') :: $(echo "$out" | tr '\n' ' ' | tail -c 260)"
    fails=$((fails + 1))
  fi
}

flake "the listing answers: the satellite is re-shrunk, the primary is left alone" 0 0 "ord (m-ord) ->" "m-ord "
flake "the listing fails once: it is tried again, and the satellite is re-shrunk" 1 0 "trying once more" "m-ord "
flake "the listing fails twice: nothing is re-shrunk, the script says so and fails" 2 1 "COULD NOT BE LISTED" ""

# ---- 3. --check asks for the Zenith tarballs too -------------------------------------------------
# announce-deploy.sh runs --check before it tells every player a restart is coming. The fetch used to
# sit AFTER the --check exit, so a fresh worktree with no tarballs and no ZENITH_VENDOR_* said "ok to
# deploy", the countdown ran, and the deploy then died at the fetch with nothing deployed. Here the
# REAL fetch script runs in a throwaway repository with one vendored dependency.
cp "$(dirname "$SCRIPT")/fetch-zenith.mjs" scripts/fetch-zenith.mjs
mkdir -p vendor/zenith
printf 'not a real tarball\n' > "$T/core.tgz"
INTEGRITY=$(node -e 'const c=require("crypto"),fs=require("fs");process.stdout.write("sha512-"+c.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$T/core.tgz")
cat > package.json <<'JSON'
{ "name": "t", "optionalDependencies": { "@horizon36596/zenith-core": "file:vendor/zenith/core.tgz" } }
JSON
printf '{ "lockfileVersion": 3, "packages": { "node_modules/@horizon36596/zenith-core": { "integrity": "%s" } } }\n' "$INTEGRITY" > package-lock.json
git add scripts/fetch-zenith.mjs package.json package-lock.json
git commit -q -m zenith 2>/dev/null && git push -q origin main
NOVENDOR=(-u ZENITH_VENDOR_REPO -u ZENITH_VENDOR_TOKEN -u ZENITH_VENDOR_REF)
run "--check refuses, before any banner, when the Zenith tarballs are missing and no vendor variables are set" 1 "vendor/zenith/core.tgz missing and ZENITH_VENDOR_REPO and ZENITH_VENDOR_TOKEN unset" "${NOVENDOR[@]}" bash "$SCRIPT" --check
out=$(env "${NOVENDOR[@]}" bash "$SCRIPT" --check 2>&1)
if echo "$out" | grep -q "ok to deploy"; then
  echo "FAIL  ...and it never says ok to deploy :: $(echo "$out" | tr '\n' ' ' | cut -c1-200)"
  fails=$((fails + 1))
else
  echo "PASS  ...and it never says ok to deploy"
fi
cp "$T/core.tgz" vendor/zenith/core.tgz
run "--check passes when the tarballs are present and match the lockfile" 0 "ok to deploy PRODUCTION" "${NOVENDOR[@]}" bash "$SCRIPT" --check

echo
[ "$fails" -eq 0 ] && echo "ALL PASS (18 cases)" || echo "$fails FAILED"
exit "$fails"
